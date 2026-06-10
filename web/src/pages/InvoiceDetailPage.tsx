import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  type FundingAccount,
  type Invoice,
  type InvoiceStatus,
  type PayLinkResponse,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { CardViewer } from "../components/CardViewer";
import { ActivityFeed } from "../components/ActivityFeed";
import { SendToVendorModal } from "../components/SendToVendorModal";
import { formatCents } from "../utils/money";

const POLL_INTERVAL_MS = 5_000;
const POLLING_STATUSES = ["CARD_ISSUED", "AUTHORIZED"] satisfies InvoiceStatus[];
const ACTIVE_CARD_STATUSES = [
  "CARD_ISSUED",
  "AUTHORIZED",
  "CLEARED",
  "RECONCILED",
] satisfies InvoiceStatus[];

function invoiceQueryKey(id: string): readonly [string, string] {
  return ["invoice", id] as const;
}

function shouldPoll(status: InvoiceStatus): boolean {
  return (POLLING_STATUSES as readonly InvoiceStatus[]).includes(status);
}

function showsCardViewer(status: InvoiceStatus): boolean {
  return (ACTIVE_CARD_STATUSES as readonly InvoiceStatus[]).includes(status);
}

function canSendToVendor(status: InvoiceStatus): boolean {
  const sendable: InvoiceStatus[] = ["CARD_ISSUED", "AUTHORIZED"];
  return sendable.includes(status);
}

export function InvoiceDetailPage() {
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();

  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!id) {
    return <Navigate to="/" replace />;
  }

  return <InvoiceDetailContent invoiceId={id} />;
}

interface InvoiceDetailContentProps {
  invoiceId: string;
}

function InvoiceDetailContent({ invoiceId }: InvoiceDetailContentProps) {
  const invoiceQuery = useQuery({
    queryKey: invoiceQueryKey(invoiceId),
    queryFn: () => api.invoices.get(invoiceId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return shouldPoll(data.status) ? POLL_INTERVAL_MS : false;
    },
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-4xl px-4 py-8">
        {invoiceQuery.isPending && <LoadingSpinner message="Loading invoice..." />}

        {invoiceQuery.isError && (
          <InvoiceErrorView error={invoiceQuery.error} />
        )}

        {invoiceQuery.isSuccess && (
          <InvoiceBody invoice={invoiceQuery.data} />
        )}
      </main>
    </div>
  );
}

interface InvoiceErrorViewProps {
  error: unknown;
}

function InvoiceErrorView({ error }: InvoiceErrorViewProps) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const isNotFound = /HTTP 404/i.test(message);
  if (isNotFound) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <p className="text-base text-gray-700">Invoice not found.</p>
        <Link
          to="/"
          className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-800"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }
  return <ErrorMessage message={message} />;
}

interface InvoiceBodyProps {
  invoice: Invoice;
}

function InvoiceBody({ invoice }: InvoiceBodyProps) {
  return (
    <>
      <PageHeader
        title={`Invoice ${invoice.invoiceNumber}`}
        subtitle={invoice.vendorName}
        showBack
      />

      <div className="mb-6 flex items-center gap-3">
        <StatusBadge status={invoice.status} />
        <span className="text-sm text-gray-500">
          Updated {new Date(invoice.updatedAt).toLocaleString()}
        </span>
      </div>

      <InvoiceFacts invoice={invoice} />

      {invoice.status === "DRAFT" && <DraftActions invoice={invoice} />}
      {invoice.status === "APPROVED" && <ApprovedTransient />}
      {invoice.status === "CANCELLED" && <CancelledBanner />}

      {showsCardViewer(invoice.status) && (
        <div className="mt-6 space-y-6">
          <CardSection invoice={invoice} />
          <ActivityFeed invoiceId={invoice.id} />
        </div>
      )}
    </>
  );
}

interface InvoiceFactsProps {
  invoice: Invoice;
}

function InvoiceFacts({ invoice }: InvoiceFactsProps) {
  return (
    <section className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:grid-cols-2">
      <Fact label="Vendor" value={invoice.vendorName} />
      <Fact label="Vendor email" value={invoice.vendorEmail} />
      <Fact label="Invoice number" value={invoice.invoiceNumber} />
      <Fact
        label="Amount"
        value={formatCents(invoice.amountCents, invoice.currencyCode)}
      />
      <Fact label="Due date" value={invoice.dueDate ?? "—"} />
      <Fact label="Expected MCC" value={invoice.expectedMcc ?? "—"} />
    </section>
  );
}

interface FactProps {
  label: string;
  value: string;
}

function Fact({ label, value }: FactProps) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-gray-900">{value}</dd>
    </div>
  );
}

function ApprovedTransient() {
  return (
    <section className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-800 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
        <span>Issuing card...</span>
      </div>
    </section>
  );
}

function CancelledBanner() {
  return (
    <section className="mt-6 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 shadow-sm">
      Invoice cancelled.
    </section>
  );
}

interface DraftActionsProps {
  invoice: Invoice;
}

function DraftActions({ invoice }: DraftActionsProps) {
  const queryClient = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const fundingQuery = useQuery({
    queryKey: ["fundingAccounts"],
    queryFn: api.fundingAccounts.list,
  });

  const accounts = fundingQuery.data ?? [];
  const autoSelectId =
    selectedAccountId ?? (accounts.length === 1 ? accounts[0].id : null);

  const approveMutation = useMutation({
    mutationFn: (sourceFundingAccountId: string) =>
      api.invoices.approve(invoice.id, { sourceFundingAccountId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invoiceQueryKey(invoice.id) });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.invoices.cancel(invoice.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invoiceQueryKey(invoice.id) });
    },
  });

  function handleApprove() {
    if (!autoSelectId) return;
    approveMutation.mutate(autoSelectId);
  }

  function handleCancel() {
    if (!window.confirm("Cancel this invoice? This cannot be undone.")) return;
    cancelMutation.mutate();
  }

  return (
    <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-900">Approve & issue card</h3>

      <FundingPicker
        accounts={accounts}
        loading={fundingQuery.isPending}
        error={
          fundingQuery.error instanceof Error
            ? fundingQuery.error.message
            : null
        }
        selectedId={autoSelectId}
        onSelect={setSelectedAccountId}
      />

      {approveMutation.isError && (
        <div className="mt-3">
          <ErrorMessage message={approveMutation.error.message} />
        </div>
      )}
      {cancelMutation.isError && (
        <div className="mt-3">
          <ErrorMessage message={cancelMutation.error.message} />
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={handleCancel}
          disabled={cancelMutation.isPending}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {cancelMutation.isPending ? "Cancelling..." : "Cancel invoice"}
        </button>
        <button
          type="button"
          onClick={handleApprove}
          disabled={!autoSelectId || approveMutation.isPending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {approveMutation.isPending ? "Issuing card..." : "Approve & issue card"}
        </button>
      </div>
    </section>
  );
}

interface FundingPickerProps {
  accounts: FundingAccount[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function FundingPicker({
  accounts,
  loading,
  error,
  selectedId,
  onSelect,
}: FundingPickerProps) {
  if (loading) {
    return (
      <p className="mt-3 text-sm text-gray-500">Loading funding accounts...</p>
    );
  }
  if (error) {
    return (
      <div className="mt-3">
        <ErrorMessage message={error} />
      </div>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-700">
        No funding accounts available —{" "}
        <Link to="/admin/funding" className="font-medium text-indigo-600 hover:text-indigo-800">
          top up via admin
        </Link>
        .
      </p>
    );
  }
  if (accounts.length === 1) {
    const account = accounts[0];
    return (
      <p className="mt-3 text-sm text-gray-700">
        Funding from <span className="font-medium">{account.name ?? account.id}</span>.
      </p>
    );
  }
  return (
    <div className="mt-3">
      <label
        htmlFor="funding-account"
        className="block text-xs font-medium text-gray-500"
      >
        Source funding account
      </label>
      <select
        id="funding-account"
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        <option value="" disabled>
          Select a funding account…
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name ?? account.id}
          </option>
        ))}
      </select>
    </div>
  );
}

interface CardSectionProps {
  invoice: Invoice;
}

function CardSection({ invoice }: CardSectionProps) {
  const [sendOpen, setSendOpen] = useState(false);
  const sendable = canSendToVendor(invoice.status);

  // The pay-link mutation lives here -- on the parent -- so that the user's
  // click event triggers it directly. The previous implementation fired it
  // from a useEffect inside the modal; React 19 StrictMode would unmount the
  // mutation observer before the response arrived, leaving the modal stuck
  // in "Generating..." even after the server returned 200.
  const payLinkMutation = useMutation<PayLinkResponse, Error>({
    mutationFn: () => api.invoices.payLink(invoice.id),
  });

  function handleSend() {
    payLinkMutation.reset();
    payLinkMutation.mutate();
    setSendOpen(true);
  }

  function handleClose() {
    setSendOpen(false);
    payLinkMutation.reset();
  }

  if (!invoice.cardId) {
    return (
      <ErrorMessage message="This invoice has no issued card yet — try refreshing in a moment." />
    );
  }

  return (
    <>
      <CardViewer invoiceId={invoice.id} paymentCardId={invoice.cardId} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSend}
          disabled={!sendable}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            sendable
              ? undefined
              : "Card is closed — pay link is no longer available"
          }
        >
          Send to vendor
        </button>
      </div>

      {sendOpen && (
        <SendToVendorModal
          invoice={invoice}
          isPending={payLinkMutation.isPending}
          isError={payLinkMutation.isError}
          errorMessage={payLinkMutation.error?.message}
          payLink={payLinkMutation.data ?? null}
          onClose={handleClose}
        />
      )}
    </>
  );
}
