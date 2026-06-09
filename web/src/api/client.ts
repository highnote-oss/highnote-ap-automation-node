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

export interface PayLinkResponse {
  slug: string;
  url: string;
  expiresAt: string;
}

export interface CardViewerTokenResponse {
  clientToken: string;
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
  },
};
