import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  NotificationEventName,
  verifyWebhookSignature,
} from "@highnote-oss/nodejs-sdk";
import { db, sqlite } from "../db/index.js";
import { invoices, webhookEvents } from "../db/schema.js";
import { highnote } from "../services/highnote.js";
import * as webhookRegistration from "../services/webhookRegistration.js";
import {
  IdParamsSchema,
  WebhookEventsQuerySchema,
  WebhookRegisterBodySchema,
  type InvoiceStatus,
} from "../types.js";

const DeliveryAttemptsQuerySchema = z.object({
  unsuccessfulOnly: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const ReplayParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** Shape of the per-event node delivered under `event.data` for the card-payment events we dispatch on. */
interface CardPaymentEventData {
  cardId?: string;
  approvedAmount?: { value?: number; currencyCode?: string };
  requestedAmount?: { value?: number; currencyCode?: string };
}

/**
 * Terminal statuses for the clearing side of the flow. If an invoice has
 * already reached one of these, a re-delivered CLEARED event is a no-op so
 * we don't double-fire `cards.close()` on a concurrent delivery.
 */
const TERMINAL_CLEARED_STATUSES = [
  "CLEARED",
  "RECONCILED",
] satisfies InvoiceStatus[];

/**
 * Advance the invoice state machine in response to a card-payment event.
 *
 * Called AFTER the raw event has been persisted to `webhook_events`, so a
 * replay can always re-derive state even if this dispatch crashes mid-flight.
 *
 * Guards:
 *   - AUTHORIZED transition only fires when the current status is exactly
 *     CARD_ISSUED, so a duplicate-delivered auth event after clearing does
 *     not regress the row.
 *   - CLEARED is skipped entirely when the invoice is already in a terminal
 *     cleared status (CLEARED or RECONCILED), so concurrent deliveries do
 *     not double-fire `cards.close()` on the upstream API.
 *   - If the cleared `approvedAmount` exactly matches the invoice's
 *     `amountCents` + `currencyCode`, we jump straight to RECONCILED (the
 *     terminal happy-path state) rather than writing an intermediate CLEARED
 *     row.
 *   - After CLEARED/RECONCILED we fire `cards.close()` on the single-use
 *     card. Failures are logged but never block the response — the close
 *     is best-effort revocation, the network already cleared the funds.
 *
 * Errors raised by the DB or upstream calls are caught and logged, never
 * thrown. The raw event row in `webhook_events` is the source of truth for
 * replay, so swallowing a dispatch error here is preferable to returning 500
 * and triggering Highnote-side retries.
 */
async function dispatchInvoiceTransition(
  log: FastifyBaseLogger,
  eventType: string,
  eventData: CardPaymentEventData,
): Promise<void> {
  try {
    const cardId = eventData.cardId;
    if (!cardId) return;

    // Match the notification event names Highnote actually delivers (the
    // CARD_PAYMENT_*_EVENT names are deprecated aliases that never arrive). A
    // single-step auth+clear — the AP "pay the invoice" path — settles the
    // invoice in one event, so it is grouped with the clearing transition.
    const isAuthorized =
      eventType === NotificationEventName.PAYMENT_CARD_AUTHORIZATION_APPROVED;
    const settles =
      eventType === NotificationEventName.PAYMENT_CARD_CLEARED ||
      eventType ===
        NotificationEventName.PAYMENT_CARD_AUTHORIZATION_AND_CLEAR_APPROVED;
    if (!isAuthorized && !settles) return;

    const invoice = db
      .select()
      .from(invoices)
      .where(eq(invoices.cardId, cardId))
      .get();
    if (!invoice) {
      log.info(
        { eventType, cardId },
        "Card-payment event delivered for unknown card; nothing to transition",
      );
      return;
    }

    const now = new Date().toISOString();

    if (isAuthorized) {
      if (invoice.status !== ("CARD_ISSUED" satisfies InvoiceStatus)) {
        log.info(
          { invoiceId: invoice.id, status: invoice.status },
          "Auth event ignored — invoice not in CARD_ISSUED",
        );
        return;
      }
      db.update(invoices)
        .set({
          status: "AUTHORIZED" satisfies InvoiceStatus,
          updatedAt: now,
        })
        .where(eq(invoices.id, invoice.id))
        .run();
      return;
    }

    // settles — clearing or single-step auth+clear
    if (
      (TERMINAL_CLEARED_STATUSES as readonly InvoiceStatus[]).includes(
        invoice.status as InvoiceStatus,
      )
    ) {
      log.info(
        { invoiceId: invoice.id, status: invoice.status },
        "Cleared event ignored — invoice already in terminal cleared status",
      );
      return;
    }

    // `approvedAmount` is the settled amount on a CLEARED event. We do NOT
    // fall back to `requestedAmount` (the pre-auth ask) because a partial
    // auth would silently look like an exact match. If `approvedAmount` is
    // missing, `exactMatch` falls through to false and we conservatively
    // land in CLEARED rather than RECONCILED.
    const cleared = eventData.approvedAmount;
    const exactMatch =
      cleared?.value === invoice.amountCents &&
      cleared?.currencyCode === invoice.currencyCode;
    const newStatus: InvoiceStatus = exactMatch ? "RECONCILED" : "CLEARED";

    db.update(invoices)
      .set({ status: newStatus, updatedAt: now })
      .where(eq(invoices.id, invoice.id))
      .run();

    try {
      await highnote.cards.close({ paymentCardId: cardId });
    } catch (err) {
      log.error({ err, cardId }, "auto-close failed");
    }
  } catch (err) {
    log.error(
      { err, eventType },
      "Invoice transition dispatch failed — event row is preserved for replay",
    );
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/webhooks — Receive webhook events (public, no JWT)
  typedApp.post(
    "/api/webhooks",
    {
      schema: {
        tags: ["Webhooks"],
        description: "Receive Highnote webhook events",
      },
      // Exempt from the global rate limit: this is the machine-to-machine
      // receiver for Highnote's webhook deliveries, which arrive in legitimate
      // bursts and are authenticated by signature verification below, not by IP.
      config: { public: true, rawBody: true, rateLimit: false },
    },
    async (request, reply) => {
      const secret = webhookRegistration.getSecret();

      const rawBody = (request as { rawBody?: string }).rawBody;
      if (!rawBody) {
        return reply.status(400).send({ error: "Missing request body" });
      }

      if (secret) {
        const signature = request.headers["highnote-signature"] as string | undefined;
        if (!signature) {
          return reply.status(401).send({ error: "Missing highnote-signature header" });
        }

        const result = verifyWebhookSignature({
          payload: rawBody,
          signature,
          secret,
        });

        if (!result.valid) {
          return reply.status(401).send({ error: "Invalid webhook signature" });
        }

        webhookRegistration.noteVerifiedEventReceived();
      } else {
        request.log.warn("Webhook signing key not available — rejecting unverifiable event");
        return reply.status(503).send({ error: "Webhook signing key not available" });
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return reply.status(400).send({ error: "Invalid JSON payload" });
      }

      // Highnote delivers a NotificationEvent nested under `data.node`:
      //   { data: { node: { id, name, node: <event detail with cardId, amounts> } } }
      // The event TYPE is `data.node.name` (e.g. PAYMENT_CARD_AUTHORIZATION_APPROVED)
      // and the per-event detail is `data.node.node`. Fall back to top-level
      // fields so any non-nested delivery still parses rather than going UNKNOWN.
      const node = (
        event.data as
          | { node?: { id?: string; name?: string; node?: unknown } }
          | undefined
      )?.node;
      const eventId = node?.id ?? (event.id as string | undefined) ?? null;
      const eventType =
        node?.name ?? (event.name as string) ?? (event.type as string) ?? "UNKNOWN";
      const isReplay = request.headers["highnote-replay"] !== undefined;

      // Persist BEFORE dispatch so a replay can re-derive state if dispatch crashes.
      if (eventId) {
        sqlite
          .prepare(
            "INSERT OR IGNORE INTO webhook_events (event_id, event_type, payload) VALUES (?, ?, ?)",
          )
          .run(eventId, eventType, rawBody);
      } else {
        request.log.warn({ eventType }, "Event missing id; inserting without idempotency");
        db.insert(webhookEvents)
          .values({ eventType, payload: rawBody })
          .run();
      }

      request.log.info({ eventType, eventId, isReplay }, "Webhook event received");

      // Dispatch invoice state transitions. The helper catches and logs
      // any thrown error so we always return 200 here — the raw event row
      // above is the source of truth for replay.
      // When the event is nested, the detail is data.node.node; fall back to {}
      // (NOT the data.node wrapper) so a missing inner shape cleanly no-ops in
      // dispatch instead of reading cardId off the wrapper. Non-nested
      // deliveries fall back to event.data.
      const eventData = (node ? (node.node ?? {}) : (event.data ?? {})) as CardPaymentEventData;
      await dispatchInvoiceTransition(app.log, eventType, eventData);

      return reply.status(200).send({ received: true });
    },
  );

  // GET /api/webhooks/events — List stored events (JWT-protected)
  typedApp.get(
    "/api/webhooks/events",
    {
      schema: {
        tags: ["Webhooks"],
        description: "List received webhook events",
        querystring: WebhookEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query;
      const events = db
        .select()
        .from(webhookEvents)
        .orderBy(desc(webhookEvents.id))
        .limit(limit)
        .offset(offset)
        .all();

      const countResult = sqlite
        .prepare("SELECT COUNT(*) as count FROM webhook_events")
        .get() as { count: number };

      return reply.send({
        events,
        total: countResult.count,
        limit,
        offset,
      });
    },
  );

  // GET /api/invoices/:id/webhook-events — List webhook events for one of the
  // operator's own invoices. The cross-user guard (join on invoices.userId)
  // returns 404 indistinguishably for unknown ids and other-user ids.
  typedApp.get(
    "/api/invoices/:id/webhook-events",
    {
      schema: {
        tags: ["Webhooks"],
        description:
          "List webhook events that landed for the given invoice (own invoices only).",
        params: IdParamsSchema,
      },
    },
    async (request, reply) => {
      const invoice = db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, request.params.id),
            eq(invoices.userId, request.user.id),
          ),
        )
        .get();
      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }

      const events = db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.invoiceId, request.params.id))
        .orderBy(desc(webhookEvents.receivedAt))
        .all();
      return { events };
    },
  );

  // GET /api/webhooks/status — Registration status (JWT-protected)
  typedApp.get(
    "/api/webhooks/status",
    {
      schema: {
        tags: ["Webhooks"],
        description: "Get current webhook registration status",
      },
    },
    async (_request, reply) => {
      return reply.send(await webhookRegistration.getStatus());
    },
  );

  // GET /api/webhooks/delivery-attempts — List Highnote's record of delivery attempts (JWT-protected)
  typedApp.get(
    "/api/webhooks/delivery-attempts",
    {
      schema: {
        tags: ["Webhooks"],
        description:
          "List recent delivery attempts as recorded by Highnote for the current target. Distinct from /events, which lists events the receiver has persisted locally.",
        querystring: DeliveryAttemptsQuerySchema,
      },
    },
    async (request, reply) => {
      const status = webhookRegistration.getStatusSync();
      if (!status.targetId) {
        return reply.send({ attempts: [], targetId: null });
      }

      const { unsuccessfulOnly, limit } = request.query;
      const attempts: Array<{
        eventId: string | null;
        eventName: string | null;
        createdAt: string | null;
        hasSuccessfulDelivery: boolean | null;
      }> = [];

      try {
        for await (const e of highnote.webhooks.listEvents(status.targetId, { unsuccessfulOnly })) {
          attempts.push({
            eventId: e.event?.id ?? null,
            eventName: e.event?.name ?? null,
            createdAt: e.event?.createdAt ?? null,
            hasSuccessfulDelivery: e.hasSuccessfulDelivery ?? null,
          });
          if (attempts.length >= limit) break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to list delivery attempts";
        return reply.status(502).send({ error: message });
      }

      return reply.send({ attempts, targetId: status.targetId });
    },
  );

  // POST /api/webhooks/events/:id/replay — Replay an event from our log via Highnote (JWT-protected)
  typedApp.post(
    "/api/webhooks/events/:id/replay",
    {
      schema: {
        tags: ["Webhooks"],
        description:
          "Ask Highnote to replay a stored event to the current target. The event must have a Highnote event id (older events without one cannot be replayed).",
        params: ReplayParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const row = db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, id))
        .get();

      if (!row) {
        return reply.status(404).send({ error: "Event not found" });
      }
      if (!row.eventId) {
        return reply.status(400).send({
          error: "This event has no Highnote event id and cannot be replayed",
        });
      }

      const status = webhookRegistration.getStatusSync();
      const targetIds = status.targetId ? [status.targetId] : undefined;

      try {
        await highnote.webhooks.replay({
          notificationEventId: row.eventId,
          targetIds,
        });
        return reply.send({ replayed: true, eventId: row.eventId, targetIds });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to replay event";
        return reply.status(502).send({ error: message });
      }
    },
  );

  // POST /api/webhooks/register — Register webhook target (JWT-protected)
  // - Empty body: re-runs auto-registration (manual retry path).
  // - Body provided: legacy explicit-name path. Registers via SDK with the given subscriptions
  //   and stores the returned signing key in memory (overrides auto-registered key).
  typedApp.post(
    "/api/webhooks/register",
    {
      schema: {
        tags: ["Webhooks"],
        description:
          "Re-register the webhook target. Send empty body to re-run auto-registration; send a body to register a custom-named target.",
        body: WebhookRegisterBodySchema.partial().optional(),
      },
    },
    async (request, reply) => {
      const body = request.body as
        | { name?: string; subscriptions?: string[] }
        | undefined;

      if (!body || (!body.name && !body.subscriptions)) {
        await webhookRegistration.init();
        return reply.send(await webhookRegistration.getStatus());
      }

      if (!body.name || !body.subscriptions) {
        return reply.status(400).send({
          error: "Both name and subscriptions are required when providing a body",
        });
      }

      const webhookUrl = webhookRegistration.getPublicWebhookUrl();
      if (!webhookUrl) {
        return reply.status(400).send({ error: "No public webhook URL configured" });
      }

      try {
        const target = await highnote.webhooks.add({
          name: body.name,
          uri: webhookUrl,
          subscriptions: body.subscriptions as never[],
        });

        return reply.status(201).send({
          id: target.id,
          name: target.name,
          uri: target.uri,
          status: target.status,
          message:
            "Webhook registered. Note: signing key is not persisted by the server in this mode.",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to register webhook";
        return reply.status(500).send({ error: message });
      }
    },
  );
}
