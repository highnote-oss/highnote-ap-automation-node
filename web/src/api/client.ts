const BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("auth_token");
}

/**
 * Auth-protected endpoints that should trigger a hard logout on 401. The
 * `/auth/login` and `/auth/signup` paths intentionally return 401 on bad
 * credentials -- those are NOT session-expired signals, just normal login
 * failures, so we exclude them.
 */
function shouldTreatAsSessionExpired(path: string): boolean {
  return !path.startsWith("/auth/");
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const token = getToken();
  // Only advertise application/json when we are actually sending a body.
  // Fastify's JSON parser rejects an empty body when content-type says JSON
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which breaks POSTs that have no payload
  // such as /cancel, /pay-link, and /card-viewer-token.
  const headers: Record<string, string> = {
    ...(init.body !== undefined && init.body !== null
      ? { "Content-Type": "application/json" }
      : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && shouldTreatAsSessionExpired(path)) {
    // Session expired or token invalidated server-side. Clear local state,
    // stop any in-flight polling by hard-navigating to /login, and surface
    // a hint via query string so the login page can explain why.
    //
    // The hard reload is intentional: it kills the React tree (and any
    // React Query polling) atomically instead of waiting for individual
    // queries to settle.
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    if (window.location.pathname !== "/login") {
      window.location.assign("/login?reason=expired");
    }
    throw new Error("Session expired");
  }
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

/**
 * Mirror of the public CA registration status returned by
 * `GET /api/collab-auth/status`. Source: `PublicStatus` in
 * `api/src/services/collabAuthRegistration.ts`. Keep in lockstep manually.
 */
export interface CollabAuthStatus {
  endpointId: string | null;
  name: string | null;
  status: string;
  registeredAt: string | null;
  lastError: string | null;
  hasSigningKey: boolean;
  source: string;
  publicUrl: string | null;
}

/**
 * Mirror of the public webhook registration status returned by
 * `GET /api/webhooks/status`. Source: `PublicStatus` in
 * `api/src/services/webhookRegistration.ts`. Keep in lockstep manually.
 */
export interface WebhooksStatus {
  targetId: string | null;
  name: string | null;
  status: string;
  registeredAt: string | null;
  lastError: string | null;
  hasSecret: boolean;
  source: string;
  subscriptionCount: number;
  publicUrl: string | null;
}

/**
 * Response shape from `GET /api/webhooks/events`.
 */
export interface WebhooksEventsResponse {
  events: WebhookEvent[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Curated subset of `MerchantCategory` from `@highnote-oss/nodejs-sdk`. The
 * SDK enum has hundreds of entries; we ship a small list the operator can use
 * from the Simulate page to exercise the CA decision tree's match/mismatch
 * paths against an invoice's `expectedMcc`.
 *
 * The `mcc` field is the typical numeric MCC Highnote emits server-side for
 * each category — used by the operator to align with (or deliberately
 * mismatch) the invoice's `expectedMcc`. Keep enum names in lockstep with the
 * SDK manually; the web package does not depend on the SDK.
 */
export const SIMULATE_CATEGORY_OPTIONS = [
  {
    value: "GROCERY_STORES_SUPERMARKETS",
    label: "Grocery stores / supermarkets",
    mcc: "5411",
  },
  {
    value: "EATING_PLACES_RESTAURANTS",
    label: "Eating places & restaurants",
    mcc: "5812",
  },
  {
    value: "FAST_FOOD_RESTAURANTS",
    label: "Fast food restaurants",
    mcc: "5814",
  },
  {
    value: "COMPUTER_SOFTWARE_STORES",
    label: "Computer software stores",
    mcc: "5734",
  },
  {
    value: "STATIONERY_STORES_OFFICE_AND_SCHOOL_SUPPLY_STORES",
    label: "Stationery / office / school supplies",
    mcc: "5943",
  },
  {
    value: "ADVERTISING_SERVICES",
    label: "Advertising services",
    mcc: "7311",
  },
  {
    value: "PROFESSIONAL_SERVICES",
    label: "Professional services",
    mcc: "8999",
  },
  {
    value: "MISCELLANEOUS_BUSINESS_SERVICES",
    label: "Miscellaneous business services",
    mcc: "7399",
  },
  {
    value: "LEGAL_SERVICES_ATTORNEYS",
    label: "Legal services / attorneys",
    mcc: "8111",
  },
  {
    value: "MEDICAL_AND_DENTAL_LABS",
    label: "Medical & dental labs",
    mcc: "8071",
  },
] as const;

export type SimulateCategoryValue =
  (typeof SIMULATE_CATEGORY_OPTIONS)[number]["value"];

/**
 * Body for `POST /api/simulate/authorize`. Mirrors
 * `SimulateAuthorizeBodySchema` in `api/src/routes/simulate.ts`. `merchantName`
 * is capped at 25 characters server-side to match Highnote's
 * `MerchantDetailsInput.name` limit.
 */
export interface SimulateAuthorizeInput {
  invoiceId: string;
  amountCents: number;
  category: SimulateCategoryValue;
  merchantName: string;
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

  webhooks: {
    status: (): Promise<WebhooksStatus> => request("/webhooks/status"),
    events: async (limit = 100): Promise<WebhookEvent[]> => {
      const body = (await request(`/webhooks/events?limit=${limit}`)) as {
        events: WebhookEvent[];
      };
      return body.events;
    },
    // POST with no body re-runs auto-registration on the backend.
    register: (): Promise<WebhooksStatus> =>
      request("/webhooks/register", { method: "POST" }),
  },

  collabAuth: {
    status: (): Promise<CollabAuthStatus> => request("/collab-auth/status"),
    decisions: async (limit = 100): Promise<CollabAuthDecision[]> => {
      const body = (await request(
        `/collab-auth/decisions?limit=${limit}`
      )) as { decisions: CollabAuthDecision[] };
      return body.decisions;
    },
    register: (): Promise<CollabAuthStatus> =>
      request("/collab-auth/register", { method: "POST" }),
  },

  simulate: {
    authorize: (body: SimulateAuthorizeInput): Promise<unknown> =>
      request("/simulate/authorize", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
};
