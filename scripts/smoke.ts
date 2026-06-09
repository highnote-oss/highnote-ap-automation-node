/**
 * End-to-end smoke test for the AP automation demo.
 *
 * Drives a running local server through the full operator flow:
 *   signup → list funding accounts → top-up → create invoice → approve
 *   → pay-by-link → public pay details → simulate auth → poll AUTHORIZED
 *   → inspect CA decisions + webhook events
 *
 * Plus a follow-up MCC-mismatch sub-flow that asserts the CA decision tree
 * declines with INVALID_MERCHANT_CATEGORY_CODE.
 *
 * Run via `npm run smoke` from the repo root with the API running locally
 * against a real Highnote test environment.
 */

import {
  CollaborativeAuthorizationResponseCode,
  Iso4217Alpha3SupportedCurrency,
  MerchantCategory,
  NotificationEventName,
} from "@highnote-oss/nodejs-sdk";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "smoke-pass-1234";

// MerchantCategory.GROCERY_STORES_SUPERMARKETS maps to MCC 5411 — used as
// the invoice's expectedMcc so the matching simulate-authorize call returns
// APPROVED through the CA decision tree.
const MATCH_MCC = "5411";
const TOPUP_AMOUNT_CENTS = 500_000;
const INVOICE_AMOUNT_CENTS = 10_000;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 10_000;
const TOPUP_SETTLE_MS = 1_000;

interface StepResult {
  index: number;
  name: string;
  status: "PASS" | "FAIL";
  durationMs: number;
  failure?: string;
}

const results: StepResult[] = [];
let token: string | null = null;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const index = results.length + 1;
  const start = Date.now();
  try {
    const value = await fn();
    const durationMs = Date.now() - start;
    results.push({ index, name, status: "PASS", durationMs });
    report({ index, name, status: "PASS", durationMs });
    return value;
  } catch (err) {
    const durationMs = Date.now() - start;
    const failure = err instanceof Error ? err.message : String(err);
    results.push({ index, name, status: "FAIL", durationMs, failure });
    report({ index, name, status: "FAIL", durationMs, failure });
    return null;
  }
}

function report(r: StepResult): void {
  const idx = `[${String(r.index).padStart(2, "0")}]`;
  const dots = ".".repeat(Math.max(2, 48 - r.name.length));
  if (r.status === "PASS") {
    console.log(`${idx} ${r.name} ${dots} PASS (${r.durationMs}ms)`);
  } else {
    console.log(`${idx} ${r.name} ${dots} FAIL: ${r.failure ?? "unknown"}`);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, auth = true } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    if (!token) throw new Error("No auth token captured yet");
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

interface FundingAccount {
  id: string;
  name?: string | null;
}

interface ListFundingAccountsResponse {
  accounts: FundingAccount[];
}

interface CreateInvoiceResponse {
  id: string;
  status: string;
}

interface ApproveInvoiceResponse {
  id: string;
  status: string;
  cardId: string;
  cardFinancialAccountId: string;
}

interface PayLinkResponse {
  slug: string;
  expiresAt: string;
}

interface PublicPayDetails {
  vendorName: string;
  amountCents: number;
  currencyCode: string;
  invoiceNumber: string;
  clientToken: string;
  cardId: string;
}

interface InvoiceRow {
  id: string;
  status: string;
}

interface CollabDecision {
  decision: string;
  reason: string | null;
}

interface ListCollabDecisionsResponse {
  decisions: CollabDecision[];
}

interface WebhookEventRow {
  eventType: string;
}

interface ListWebhookEventsResponse {
  events: WebhookEventRow[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollForStatus(
  invoiceId: string,
  target: string,
): Promise<InvoiceRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: InvoiceRow | null = null;
  while (Date.now() < deadline) {
    const inv = await request<InvoiceRow>(`/api/invoices/${invoiceId}`);
    last = inv;
    if (inv.status === target) return inv;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out after ${POLL_TIMEOUT_MS}ms — last status: ${last?.status ?? "unknown"}`,
  );
}

interface ApprovedInvoice {
  invoiceId: string;
  payLinkSlug?: string;
}

async function createAndApproveInvoice(
  fundingAccountId: string,
  invoiceNumber: string,
  expectedMcc: string,
): Promise<string> {
  const created = await request<CreateInvoiceResponse>("/api/invoices", {
    method: "POST",
    body: {
      vendorName: "Smoke Vendor",
      vendorEmail: "vendor@example.com",
      invoiceNumber,
      amountCents: INVOICE_AMOUNT_CENTS,
      currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      expectedMcc,
    },
  });
  const approved = await request<ApproveInvoiceResponse>(
    `/api/invoices/${created.id}/approve`,
    {
      method: "POST",
      body: { sourceFundingAccountId: fundingAccountId },
    },
  );
  if (approved.status !== "CARD_ISSUED") {
    throw new Error(`expected CARD_ISSUED, got ${approved.status}`);
  }
  return created.id;
}

async function runMccMismatchFlow(fundingAccountId: string): Promise<void> {
  const invoiceNumber = `SMOKE-MISMATCH-${Date.now()}`;
  let invoiceId: string | null = null;

  await step("MCC-mismatch: create + approve invoice", async () => {
    invoiceId = await createAndApproveInvoice(
      fundingAccountId,
      invoiceNumber,
      MATCH_MCC,
    );
    return invoiceId;
  });
  if (!invoiceId) return;

  await step("MCC-mismatch: simulate authorize (5812)", async () => {
    return request("/api/simulate/authorize", {
      method: "POST",
      body: {
        invoiceId,
        amountCents: INVOICE_AMOUNT_CENTS,
        category: MerchantCategory.EATING_PLACES_RESTAURANTS,
        merchantName: "Mismatch Test Co",
      },
    });
  });

  await step("MCC-mismatch: CA decision INVALID_MCC", async () => {
    // Highnote needs a beat to deliver the CA call after simulate-authorize
    // returns; poll up to POLL_TIMEOUT_MS for at least one decision row to
    // land instead of asserting on the first read.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let decisions: CollabDecision[] = [];
    while (Date.now() < deadline) {
      const res = await request<ListCollabDecisionsResponse>(
        `/api/invoices/${invoiceId}/collab-decisions`,
      );
      decisions = res.decisions;
      if (decisions.length > 0) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (decisions.length === 0) {
      throw new Error("no CA decision recorded for mismatch invoice");
    }
    const latest = decisions[0];
    if (
      latest.decision !==
      CollaborativeAuthorizationResponseCode.INVALID_MERCHANT_CATEGORY_CODE
    ) {
      throw new Error(
        `expected INVALID_MERCHANT_CATEGORY_CODE, got ${latest.decision}`,
      );
    }
    console.log(`     ↳ decision=${latest.decision} reason=${latest.reason}`);
    return latest;
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(`Smoke target: ${BASE_URL}`);
  const email = `smoke-${Date.now()}@example.com`;

  await step("Health check", async () => {
    const res = await request<{ status: string }>("/health", { auth: false });
    if (res.status !== "ok") throw new Error(`status=${res.status}`);
    return res;
  });

  const signupResult = await step("Signup new user", async () => {
    const res = await request<{ token: string; user: { id: number; email: string } }>(
      "/api/auth/signup",
      {
        method: "POST",
        auth: false,
        body: { email, password: PASSWORD },
      },
    );
    if (!res.token) throw new Error("no token returned");
    token = res.token;
    return res;
  });
  if (!signupResult) {
    finishAndExit(startedAt);
    return;
  }

  const fundingAccount = await step("List funding accounts", async () => {
    const res = await request<ListFundingAccountsResponse>(
      "/api/funding-accounts",
    );
    if (!res.accounts || res.accounts.length === 0) {
      throw new Error(
        "no funding accounts available — register a funding account on the Highnote dashboard for card product $HIGHNOTE_CARD_PRODUCT_ID before re-running",
      );
    }
    return res.accounts[0];
  });
  if (!fundingAccount) {
    finishAndExit(startedAt);
    return;
  }

  await step("Top up funding account", async () => {
    return request(`/api/admin/funding/${fundingAccount.id}/topup`, {
      method: "POST",
      body: {
        amountCents: TOPUP_AMOUNT_CENTS,
        currencyCode: Iso4217Alpha3SupportedCurrency.USD,
      },
    });
  });

  // Brief settle before issuing — gives the ledger a moment so the card
  // issuance has funding available.
  await sleep(TOPUP_SETTLE_MS);

  const invoiceNumber = `SMOKE-${Date.now()}`;
  const createdInvoice = await step("Create draft invoice", async () => {
    return request<CreateInvoiceResponse>("/api/invoices", {
      method: "POST",
      body: {
        vendorName: "Smoke Vendor",
        vendorEmail: "vendor@example.com",
        invoiceNumber,
        amountCents: INVOICE_AMOUNT_CENTS,
        currencyCode: Iso4217Alpha3SupportedCurrency.USD,
        expectedMcc: MATCH_MCC,
      },
    });
  });
  if (!createdInvoice) {
    finishAndExit(startedAt);
    return;
  }
  const invoiceId = createdInvoice.id;

  const approved = await step("Approve invoice → CARD_ISSUED", async () => {
    const res = await request<ApproveInvoiceResponse>(
      `/api/invoices/${invoiceId}/approve`,
      {
        method: "POST",
        body: { sourceFundingAccountId: fundingAccount.id },
      },
    );
    if (res.status !== "CARD_ISSUED") {
      throw new Error(`expected CARD_ISSUED, got ${res.status}`);
    }
    return res;
  });
  if (!approved) {
    finishAndExit(startedAt);
    return;
  }

  const payLink = await step("Generate pay-by-link", async () => {
    const res = await request<PayLinkResponse>(
      `/api/invoices/${invoiceId}/pay-link`,
      { method: "POST" },
    );
    if (!res.slug || !res.expiresAt) {
      throw new Error("missing slug or expiresAt");
    }
    return res;
  });

  if (payLink) {
    await step("Fetch public pay details", async () => {
      const res = await request<PublicPayDetails>(`/api/pay/${payLink.slug}`, {
        auth: false,
      });
      const requiredKeys: (keyof PublicPayDetails)[] = [
        "vendorName",
        "amountCents",
        "currencyCode",
        "invoiceNumber",
        "clientToken",
        "cardId",
      ];
      const missing = requiredKeys.filter((k) => res[k] === undefined);
      if (missing.length > 0) {
        throw new Error(`missing fields: ${missing.join(", ")}`);
      }
      return res;
    });
  }

  await step("Simulate authorize (5411 match)", async () => {
    return request("/api/simulate/authorize", {
      method: "POST",
      body: {
        invoiceId,
        amountCents: INVOICE_AMOUNT_CENTS,
        category: MerchantCategory.GROCERY_STORES_SUPERMARKETS,
        merchantName: "Smoke Test Co",
      },
    });
  });

  await step("Poll invoice → AUTHORIZED", async () => {
    return pollForStatus(invoiceId, "AUTHORIZED");
  });

  await step("CA decisions present", async () => {
    const res = await request<ListCollabDecisionsResponse>(
      `/api/invoices/${invoiceId}/collab-decisions`,
    );
    if (res.decisions.length === 0) {
      throw new Error("expected ≥1 decision, got 0");
    }
    const latest = res.decisions[0];
    console.log(`     ↳ decision=${latest.decision} reason=${latest.reason}`);
    return res;
  });

  await step("Webhook events present", async () => {
    const res = await request<ListWebhookEventsResponse>(
      `/api/invoices/${invoiceId}/webhook-events`,
    );
    const authorizedEvents = res.events.filter(
      (e) => e.eventType === NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT,
    );
    if (authorizedEvents.length === 0) {
      throw new Error(
        `expected ≥1 ${NotificationEventName.CARD_PAYMENT_AUTHORIZED_EVENT}, got ${res.events.length} events of other types`,
      );
    }
    return res;
  });

  // MCC-mismatch sub-flow exercises the negative path through the CA tree.
  await runMccMismatchFlow(fundingAccount.id);

  finishAndExit(startedAt);
}

function finishAndExit(startedAt: number): void {
  const elapsedMs = Date.now() - startedAt;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("");
  console.log(
    `Done in ${elapsedMs}ms — ${passed} passed, ${failed} failed (${results.length} total).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(1);
});
