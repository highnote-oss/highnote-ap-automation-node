import { useMemo, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  SIMULATE_CATEGORY_OPTIONS,
  type Invoice,
  type InvoiceStatus,
  type SimulateAuthorizeInput,
  type SimulateCategoryValue,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { dollarsToCents, formatCents } from "../utils/money";

// Highnote caps `MerchantDetailsInput.name` at 25 characters. Mirror of the
// `MERCHANT_NAME_MAX` constant in `api/src/routes/simulate.ts`.
const MERCHANT_NAME_MAX = 25;

// Invoices that have an issued card the simulator can target.
const SIMULATABLE_STATUSES = [
  "CARD_ISSUED",
  "AUTHORIZED",
] satisfies InvoiceStatus[];

function isSimulatable(status: InvoiceStatus): boolean {
  return (SIMULATABLE_STATUSES as readonly InvoiceStatus[]).includes(status);
}

interface SimulateFormErrors {
  invoiceId?: string;
  amount?: string;
  merchantName?: string;
}

interface SimulateSuccess {
  eventId: string | null;
  invoiceId: string;
}

export function SimulatePage() {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <PageHeader
          title="Simulate payment"
          subtitle="Trigger a test-environment auth + clear against an issued card"
        />
        <SimulateForm />
        <ExplainerCard />
      </main>
    </div>
  );
}

function SimulateForm() {
  const [invoiceId, setInvoiceId] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [category, setCategory] = useState<SimulateCategoryValue>(
    SIMULATE_CATEGORY_OPTIONS[0].value
  );
  const [merchantName, setMerchantName] = useState("");
  const [errors, setErrors] = useState<SimulateFormErrors>({});
  const [success, setSuccess] = useState<SimulateSuccess | null>(null);

  const invoicesQuery = useQuery<Invoice[]>({
    queryKey: ["invoices"],
    queryFn: api.invoices.list,
  });

  const candidateInvoices = useMemo<Invoice[]>(() => {
    if (!invoicesQuery.data) return [];
    return invoicesQuery.data.filter((invoice) => isSimulatable(invoice.status));
  }, [invoicesQuery.data]);

  const selectedInvoice = useMemo<Invoice | null>(() => {
    return candidateInvoices.find((i) => i.id === invoiceId) ?? null;
  }, [candidateInvoices, invoiceId]);

  const simulate = useMutation({
    mutationFn: (body: SimulateAuthorizeInput) => api.simulate.authorize(body),
    onSuccess: (response, variables) => {
      const eventId = extractEventId(response);
      setSuccess({ eventId, invoiceId: variables.invoiceId });
    },
  });

  function validate(): SimulateFormErrors | null {
    const next: SimulateFormErrors = {};
    if (!invoiceId) next.invoiceId = "Select an invoice with an issued card";
    const cents = dollarsToCents(amountDollars);
    if (cents === null) next.amount = "Enter an amount greater than 0";
    const trimmedName = merchantName.trim();
    if (!trimmedName) {
      next.merchantName = "Merchant name is required";
    } else if (trimmedName.length > MERCHANT_NAME_MAX) {
      next.merchantName = `Maximum ${MERCHANT_NAME_MAX} characters`;
    }
    return Object.keys(next).length > 0 ? next : null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSuccess(null);
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    const cents = dollarsToCents(amountDollars);
    if (cents === null) return;
    simulate.mutate({
      invoiceId,
      amountCents: cents,
      category,
      merchantName: merchantName.trim(),
    });
  }

  if (invoicesQuery.isPending) {
    return <LoadingSpinner message="Loading invoices..." />;
  }

  if (invoicesQuery.isError) {
    return (
      <ErrorMessage
        message={
          invoicesQuery.error instanceof Error
            ? invoicesQuery.error.message
            : "Failed to load invoices"
        }
      />
    );
  }

  if (candidateInvoices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
        No simulatable invoices. Approve an invoice from the Dashboard to issue a
        card, then come back here.
      </div>
    );
  }

  const submitError =
    simulate.error instanceof Error ? simulate.error.message : null;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
    >
      {submitError && <ErrorMessage message={submitError} />}

      {success && (
        <SimulateSuccessMessage
          success={success}
          onDismiss={() => setSuccess(null)}
        />
      )}

      <div>
        <label
          htmlFor="invoiceId"
          className="block text-sm font-medium text-gray-700"
        >
          Invoice
        </label>
        <select
          id="invoiceId"
          value={invoiceId}
          onChange={(e) => setInvoiceId(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Select an invoice...</option>
          {candidateInvoices.map((invoice) => (
            <option key={invoice.id} value={invoice.id}>
              {invoice.invoiceNumber} — {invoice.vendorName} —{" "}
              {formatCents(invoice.amountCents, invoice.currencyCode)}
            </option>
          ))}
        </select>
        {errors.invoiceId && (
          <p className="mt-1 text-xs text-red-600">{errors.invoiceId}</p>
        )}
        {selectedInvoice && (
          <p className="mt-2 text-xs text-gray-500">
            Status: <span className="font-medium">{selectedInvoice.status}</span>
            {" · "}
            Expected MCC:{" "}
            <span className="font-mono">
              {selectedInvoice.expectedMcc ?? "any (no constraint)"}
            </span>
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="amount"
          className="block text-sm font-medium text-gray-700"
        >
          Amount (USD)
        </label>
        <input
          id="amount"
          type="number"
          step="0.01"
          min="0.01"
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          placeholder="0.00"
          className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 ${
            errors.amount
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
        />
        {errors.amount && (
          <p className="mt-1 text-xs text-red-600">{errors.amount}</p>
        )}
        {selectedInvoice && (
          <p className="mt-1 text-xs text-gray-500">
            Invoice amount:{" "}
            {formatCents(
              selectedInvoice.amountCents,
              selectedInvoice.currencyCode,
            )}
            . Above this triggers INSUFFICIENT_FUNDS.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="category"
          className="block text-sm font-medium text-gray-700"
        >
          Merchant category
        </label>
        <select
          id="category"
          value={category}
          onChange={(e) => setCategory(e.target.value as SimulateCategoryValue)}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          {SIMULATE_CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} (MCC {option.mcc})
            </option>
          ))}
        </select>
        {selectedInvoice?.expectedMcc && (
          <p className="mt-1 text-xs text-gray-500">
            Invoice expects MCC{" "}
            <span className="font-mono">{selectedInvoice.expectedMcc}</span>.
            Pick a category whose MCC mismatches to test the
            INVALID_MERCHANT_CATEGORY_CODE branch.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="merchantName"
          className="block text-sm font-medium text-gray-700"
        >
          Merchant name
        </label>
        <input
          id="merchantName"
          type="text"
          maxLength={MERCHANT_NAME_MAX}
          value={merchantName}
          onChange={(e) => setMerchantName(e.target.value)}
          placeholder="Acme Stores"
          className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 ${
            errors.merchantName
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500"
          }`}
        />
        <p className="mt-1 text-xs text-gray-500">
          {merchantName.trim().length}/{MERCHANT_NAME_MAX} characters
        </p>
        {errors.merchantName && (
          <p className="mt-1 text-xs text-red-600">{errors.merchantName}</p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={simulate.isPending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {simulate.isPending ? "Simulating..." : "Simulate payment (auth + clear)"}
        </button>
      </div>
    </form>
  );
}

interface SimulateSuccessMessageProps {
  success: SimulateSuccess;
  onDismiss: () => void;
}

function SimulateSuccessMessage({
  success,
  onDismiss,
}: SimulateSuccessMessageProps) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm text-emerald-800">
          <p className="font-semibold">Authorization submitted.</p>
          {success.eventId && (
            <p className="mt-1 font-mono text-xs">Event: {success.eventId}</p>
          )}
          <p className="mt-2">
            <Link
              to={`/invoices/${success.invoiceId}`}
              className="font-medium text-emerald-700 underline hover:text-emerald-900"
            >
              View the invoice's activity feed →
            </Link>
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-emerald-400 hover:text-emerald-700"
          aria-label="Dismiss"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ExplainerCard() {
  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white/60 p-5 text-sm text-gray-600 shadow-sm">
      <p>
        This simulates paying the invoice: a single-step authorization + clear
        against the card already issued for it. The collaborative-auth endpoint
        decides the authorization synchronously — change the amount or MCC to
        exercise each branch of the decision tree — then it clears, settling the
        invoice (CARD_ISSUED → CLEARED). Both the CA decision and the webhook
        event appear in the invoice's activity feed.
      </p>
    </section>
  );
}

/**
 * Best-effort extraction of the event id from the Highnote simulate response.
 * The SDK returns the upstream event; the precise wrapper shape varies. We
 * probe the common keys defensively rather than typing the full SDK response
 * locally.
 */
function extractEventId(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const root = response as Record<string, unknown>;
  if (typeof root.id === "string") return root.id;
  if (typeof root.eventId === "string") return root.eventId;
  return null;
}
