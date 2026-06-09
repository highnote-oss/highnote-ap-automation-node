const BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface AuthUser {
  id: number;
  email: string;
  accountHolderId: string | null;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

/**
 * Mirror of the backend `InvoiceStatus` union from `api/src/types.ts`.
 * Keep in lockstep manually — the web package does not import from `api/src/`.
 */
export type InvoiceStatus =
  | "DRAFT"
  | "APPROVED"
  | "CARD_ISSUED"
  | "AUTHORIZED"
  | "CLEARED"
  | "RECONCILED"
  | "CANCELLED";

/**
 * Mirror of `Iso4217Alpha3SupportedCurrency` from `@highnote-oss/nodejs-sdk`.
 * The Highnote SDK is server-side only; this duplicates the supported set so
 * the web bundle does not pull in the SDK. Keep in lockstep manually.
 */
export const SupportedCurrency = {
  USD: "USD",
} as const;

export type SupportedCurrencyCode =
  (typeof SupportedCurrency)[keyof typeof SupportedCurrency];

/**
 * Mirror of the `invoices` row shape returned by `api/src/routes/invoices.ts`.
 * Reflects the Drizzle schema in `api/src/db/schema.ts`.
 */
export interface Invoice {
  id: string;
  userId: number;
  vendorName: string;
  vendorEmail: string;
  invoiceNumber: string;
  amountCents: number;
  currencyCode: SupportedCurrencyCode;
  dueDate: string | null;
  expectedMcc: string | null;
  pdfPath: string | null;
  status: InvoiceStatus;
  sourceFundingAccountId: string | null;
  cardId: string | null;
  cardFinancialAccountId: string | null;
  payBySlug: string | null;
  payByClientToken: string | null;
  payBySlugExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvoiceInput {
  vendorName: string;
  vendorEmail: string;
  invoiceNumber: string;
  amountCents: number;
  currencyCode: SupportedCurrencyCode;
  dueDate?: string;
  expectedMcc?: string;
  pdfPath?: string;
}

export interface ApproveInvoiceInput {
  sourceFundingAccountId: string;
}

export interface ApproveInvoiceResponse {
  id: string;
  status: InvoiceStatus;
  cardId: string;
  cardFinancialAccountId: string;
}

/**
 * Response from `POST /api/invoices/:id/pay-link`. The backend only mints the
 * slug + expiry; the SPA builds the full URL via `window.location.origin`.
 */
export interface PayLinkResponse {
  slug: string;
  expiresAt: string;
}

/**
 * The card-viewer token route returns the raw Highnote `ClientToken` shape:
 * the SDK exposes `value` and `expirationDate`. Keep this aligned with the
 * SDK's `ClientToken` interface — `value` is what feeds the Card Viewer's
 * `clientToken` field.
 */
export interface CardViewerTokenResponse {
  value: string;
  expirationDate: string;
}

/**
 * Mirror of the `collab_auth_decisions` row shape from `api/src/db/schema.ts`.
 * Returned by `GET /api/invoices/:id/collab-decisions`.
 */
export interface CollabAuthDecision {
  id: number;
  invoiceId: string | null;
  paymentCardId: string;
  requestId: string;
  requestedAmountCents: number;
  merchantCategoryCode: string | null;
  decision: string;
  reason: string | null;
  rawPayload: string;
  receivedAt: string;
}

/**
 * Mirror of the `webhook_events` row shape from `api/src/db/schema.ts`.
 * Returned by `GET /api/invoices/:id/webhook-events`.
 */
export interface WebhookEvent {
  id: number;
  eventId: string | null;
  eventType: string;
  invoiceId: string | null;
  payload: string;
  receivedAt: string;
}

/**
 * Mirror of the funding accounts returned by `GET /api/funding-accounts`.
 * The Highnote SDK's `FinancialAccount` is large; we read only the fields the
 * picker and admin page need, so the type stays narrow and the backend stays
 * free to evolve.
 *
 * The backend returns the SDK's `AccountHolderFinancialAccountSummary`, which
 * is the `FinancialAccountSummaryFragment` shape: `id`, `name`, `features[]`,
 * `ledgers[]`. The summary does not include `accountStatus` directly, so the
 * admin page derives a display status from the enabled features.
 */
export interface FundingAccountLedger {
  name?: string;
  creditBalance?: { value?: number | string; currencyCode?: string } | null;
  debitBalance?: { value?: number | string; currencyCode?: string } | null;
}

export interface FundingAccountFeature {
  __typename?: string;
  enabled?: boolean;
}

export interface FundingAccount {
  id: string;
  name?: string | null;
  features?: FundingAccountFeature[] | null;
  ledgers?: FundingAccountLedger[] | null;
  availableCash?: { value: number; currencyCode: string } | null;
}

export interface TopUpInput {
  amountCents: number;
  currencyCode: SupportedCurrencyCode;
}

export const api = {
  signup: (email: string, password: string): Promise<AuthResponse> =>
    request("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string): Promise<AuthResponse> =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: (): Promise<AuthUser> => request("/me"),

  invoices: {
    list: async (): Promise<Invoice[]> => {
      const body = (await request("/invoices")) as { invoices: Invoice[] };
      return body.invoices;
    },
    get: (id: string): Promise<Invoice> => request(`/invoices/${id}`),
    create: (body: CreateInvoiceInput): Promise<Invoice> =>
      request("/invoices", { method: "POST", body: JSON.stringify(body) }),
    approve: (
      id: string,
      body: ApproveInvoiceInput
    ): Promise<ApproveInvoiceResponse> =>
      request(`/invoices/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    cancel: (id: string): Promise<{ id: string; status: InvoiceStatus }> =>
      request(`/invoices/${id}/cancel`, { method: "POST" }),
    payLink: (id: string): Promise<PayLinkResponse> =>
      request(`/invoices/${id}/pay-link`, { method: "POST" }),
    cardViewerToken: (id: string): Promise<CardViewerTokenResponse> =>
      request(`/invoices/${id}/card-viewer-token`, { method: "POST" }),
    collabAuthDecisions: async (id: string): Promise<CollabAuthDecision[]> => {
      const body = (await request(`/invoices/${id}/collab-decisions`)) as {
        decisions: CollabAuthDecision[];
      };
      return body.decisions;
    },
    webhookEvents: async (id: string): Promise<WebhookEvent[]> => {
      const body = (await request(`/invoices/${id}/webhook-events`)) as {
        events: WebhookEvent[];
      };
      return body.events;
    },
  },

  fundingAccounts: {
    list: async (): Promise<FundingAccount[]> => {
      const body = (await request("/funding-accounts")) as {
        accounts: FundingAccount[];
      };
      return body.accounts;
    },
    topup: (
      id: string,
      amountCents: number,
      currencyCode: SupportedCurrencyCode = SupportedCurrency.USD
    ): Promise<unknown> =>
      request(`/admin/funding/${id}/topup`, {
        method: "POST",
        body: JSON.stringify({ amountCents, currencyCode }),
      }),
  },
};
