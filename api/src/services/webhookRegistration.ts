/**
 * Webhook auto-registration on server start.
 *
 * On Render, registers a fresh notification target with Highnote each deploy
 * and holds the signing key in process memory. Cleanup of stale targets is
 * out of scope for this branch (see SDK enhancement spec) — Highnote
 * auto-deactivates undeliverable targets after retries.
 *
 * Locally, init() resolves to no public URL and skips registration; the
 * existing manual register endpoint and frontend polling continue to work.
 */

import { NotificationEventName } from "@highnote-oss/nodejs-sdk";
import { highnote } from "./highnote.js";

export type RegistrationStatus =
  | "NOT_REGISTERED"
  | "PENDING_VERIFICATION"
  | "ACTIVE"
  | "DEACTIVATED"
  | "REGISTRATION_FAILED";

export type RegistrationSource = "auto" | "manual" | "none";

interface InternalState {
  targetId: string | null;
  name: string | null;
  status: RegistrationStatus;
  signingKeySecret: string | null;
  registeredAt: string | null;
  lastError: string | null;
  source: RegistrationSource;
  subscriptionCount: number;
  publicUrl: string | null;
}

export interface PublicStatus {
  targetId: string | null;
  name: string | null;
  status: RegistrationStatus;
  registeredAt: string | null;
  lastError: string | null;
  hasSecret: boolean;
  source: RegistrationSource;
  subscriptionCount: number;
  publicUrl: string | null;
}

const state: InternalState = {
  targetId: null,
  name: null,
  status: "NOT_REGISTERED",
  signingKeySecret: null,
  registeredAt: null,
  lastError: null,
  source: "none",
  subscriptionCount: 0,
  publicUrl: null,
};

let inFlight: Promise<void> | null = null;

function resolvePublicUrl(): { url: string | null; source: RegistrationSource } {
  const override = process.env.WEBHOOK_PUBLIC_URL?.trim();
  if (override) {
    return { url: `${override.replace(/\/+$/, "")}/api/webhooks`, source: "manual" };
  }
  if (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_URL) {
    return {
      url: `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/api/webhooks`,
      source: "auto",
    };
  }
  return { url: null, source: "none" };
}

function resolveTargetName(): string {
  const sha = process.env.RENDER_GIT_COMMIT?.slice(0, 7);
  return `bay19-auto-${sha ?? Date.now()}`;
}

function mapTargetStatus(input: string | undefined): RegistrationStatus {
  switch (input) {
    case "ACTIVE":
      return "ACTIVE";
    case "PENDING_VERIFICATION":
      return "PENDING_VERIFICATION";
    case "DEACTIVATED":
      return "DEACTIVATED";
    default:
      return "PENDING_VERIFICATION";
  }
}

const TARGET_NAME_PREFIX = "bay19-auto-";

async function cleanupStaleTargets(currentName: string): Promise<number> {
  let removed = 0;
  for await (const t of highnote.webhooks.list()) {
    if (!t.name?.startsWith(TARGET_NAME_PREFIX)) continue;
    if (t.name === currentName) continue;
    try {
      await highnote.webhooks.remove({ targetId: t.id });
      removed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[webhooks] Failed to remove stale target ${t.id} (${t.name}): ${message}`);
    }
  }
  return removed;
}

async function doRegister(): Promise<void> {
  const { url, source } = resolvePublicUrl();
  state.publicUrl = url;
  state.source = source;

  if (!url) {
    state.status = "NOT_REGISTERED";
    state.lastError = null;
    console.log("[webhooks] No public URL detected (RENDER_EXTERNAL_URL or WEBHOOK_PUBLIC_URL); skipping auto-register.");
    return;
  }

  const name = resolveTargetName();
  const subscriptions = Object.values(NotificationEventName);

  try {
    try {
      const removed = await cleanupStaleTargets(name);
      if (removed > 0) {
        console.log(`[webhooks] Removed ${removed} stale ${TARGET_NAME_PREFIX}* target(s) before registering.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[webhooks] Cleanup phase failed (continuing to register): ${message}`);
    }

    const target = await highnote.webhooks.add({
      name,
      uri: url,
      subscriptions,
    });

    const secret = target.signingKeys?.[0]?.secret ?? null;
    if (!secret) {
      throw new Error("addWebhookNotificationTarget returned no signing key secret");
    }

    state.targetId = target.id;
    state.name = target.name ?? name;
    state.status = mapTargetStatus(target.status);
    state.signingKeySecret = secret;
    state.registeredAt = target.createdAt ?? new Date().toISOString();
    state.lastError = null;
    state.subscriptionCount = subscriptions.length;

    console.log(
      `[webhooks] Registered target ${target.id} (${state.name}) with ${subscriptions.length} subscriptions; status=${state.status}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = "REGISTRATION_FAILED";
    state.lastError = message;
    state.signingKeySecret = null;
    state.targetId = null;
    state.name = null;
    state.registeredAt = null;
    state.subscriptionCount = 0;
    console.error(`[webhooks] Registration failed: ${message}`);
  }
}

/**
 * Idempotent, single-flight registration. Concurrent callers await the same
 * promise. Errors are caught and recorded in state — does not throw.
 */
export function init(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doRegister().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** In-memory signing key for the receiver. `null` means signature verification is skipped. */
export function getSecret(): string | null {
  return state.signingKeySecret;
}

/**
 * The server-resolved public `/api/webhooks` URL, or `null` if none is
 * configured. Derived only from server env — never from request headers.
 */
export function getPublicWebhookUrl(): string | null {
  return resolvePublicUrl().url;
}

/**
 * Called by the receiver after a successfully-verified event. Optimistically
 * advances PENDING_VERIFICATION → ACTIVE so the cached status is correct
 * even before the next live-refresh (`getStatus()`) hits Highnote.
 */
export function noteVerifiedEventReceived(): void {
  if (state.status === "PENDING_VERIFICATION") {
    state.status = "ACTIVE";
  }
}

function snapshot(): PublicStatus {
  return {
    targetId: state.targetId,
    name: state.name,
    status: state.status,
    registeredAt: state.registeredAt,
    lastError: state.lastError,
    hasSecret: state.signingKeySecret !== null,
    source: state.source,
    subscriptionCount: state.subscriptionCount,
    publicUrl: state.publicUrl,
  };
}

/**
 * Public-safe view of registration state. Never includes the signing key.
 *
 * When a targetId exists, best-effort live-refreshes the status from
 * Highnote so the UI reflects the true current state (PENDING_VERIFICATION
 * vs ACTIVE vs DEACTIVATED). On lookup failure, returns cached state.
 */
export async function getStatus(): Promise<PublicStatus> {
  if (state.targetId) {
    try {
      const live = await highnote.webhooks.get(state.targetId);
      state.status = mapTargetStatus(live.status);
      if (live.name) state.name = live.name;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[webhooks] Live status refresh failed: ${message}`);
    }
  }
  return snapshot();
}

/** Synchronous snapshot, no live refresh. Useful when avoiding an extra API call. */
export function getStatusSync(): PublicStatus {
  return snapshot();
}
