import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  SupportedCurrency,
  type CreateInvoiceInput,
  type Invoice,
  type SupportedCurrencyCode,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { EmptyState } from "../components/EmptyState";
import { dollarsToCents, formatCents } from "../utils/money";

const INVOICES_QUERY_KEY = ["invoices"] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const invoicesQuery = useQuery({
    queryKey: INVOICES_QUERY_KEY,
    queryFn: api.invoices.list,
    enabled: !!user,
  });

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  function openCreate() {
    setIsCreateOpen(true);
  }

  function closeCreate() {
    setIsCreateOpen(false);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-start justify-between">
          <PageHeader title="Invoices" />
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
          >
            New invoice
          </button>
        </div>

        {invoicesQuery.isPending && <LoadingSpinner message="Loading invoices..." />}

        {invoicesQuery.isError && (
          <ErrorMessage
            message={
              invoicesQuery.error instanceof Error
                ? invoicesQuery.error.message
                : "Failed to load invoices"
            }
          />
        )}

        {invoicesQuery.isSuccess && invoicesQuery.data.length === 0 && (
          <EmptyState
            message="No invoices yet"
            actionLabel="Create your first invoice"
            onAction={openCreate}
          />
        )}

        {invoicesQuery.isSuccess && invoicesQuery.data.length > 0 && (
          <InvoiceTable
            invoices={invoicesQuery.data}
            onRowClick={(id) => navigate(`/invoices/${id}`)}
          />
        )}
      </main>

      {isCreateOpen && (
        <CreateInvoiceModal
          onClose={closeCreate}
          onCreated={closeCreate}
        />
      )}
    </div>
  );
}

interface InvoiceTableProps {
  invoices: Invoice[];
  onRowClick: (id: string) => void;
}

function InvoiceTable({ invoices, onRowClick }: InvoiceTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <Th>Vendor</Th>
            <Th>Invoice #</Th>
            <Th>Amount</Th>
            <Th>Status</Th>
            <Th>Due Date</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {invoices.map((invoice) => (
            <tr
              key={invoice.id}
              onClick={() => onRowClick(invoice.id)}
              className="cursor-pointer hover:bg-indigo-50 transition-colors"
            >
              <Td>
                <div className="font-medium text-gray-900">{invoice.vendorName}</div>
                <div className="text-xs text-gray-500">{invoice.vendorEmail}</div>
              </Td>
              <Td>{invoice.invoiceNumber}</Td>
              <Td>{formatCents(invoice.amountCents, invoice.currencyCode)}</Td>
              <Td>
                <StatusBadge status={invoice.status} />
              </Td>
              <Td>{invoice.dueDate ?? "—"}</Td>
              <Td className="text-right">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRowClick(invoice.id);
                  }}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
                >
                  View
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 text-sm text-gray-700 ${className}`}>{children}</td>;
}

interface CreateInvoiceModalProps {
  onClose: () => void;
  onCreated: () => void;
}

interface CreateInvoiceFormErrors {
  vendorName?: string;
  vendorEmail?: string;
  invoiceNumber?: string;
  amount?: string;
}

function CreateInvoiceModal({ onClose, onCreated }: CreateInvoiceModalProps) {
  const queryClient = useQueryClient();
  const [vendorName, setVendorName] = useState("");
  const [vendorEmail, setVendorEmail] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amountDollars, setAmountDollars] = useState("");
  const [currencyCode, setCurrencyCode] = useState<SupportedCurrencyCode>(
    SupportedCurrency.USD
  );
  const [dueDate, setDueDate] = useState("");
  const [expectedMcc, setExpectedMcc] = useState("");
  const [errors, setErrors] = useState<CreateInvoiceFormErrors>({});

  const createMutation = useMutation({
    mutationFn: (input: CreateInvoiceInput) => api.invoices.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INVOICES_QUERY_KEY });
      onCreated();
    },
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function validate(): CreateInvoiceFormErrors | null {
    const next: CreateInvoiceFormErrors = {};
    if (!vendorName.trim()) next.vendorName = "Vendor name is required";
    if (!vendorEmail.trim()) {
      next.vendorEmail = "Vendor email is required";
    } else if (!EMAIL_PATTERN.test(vendorEmail.trim())) {
      next.vendorEmail = "Enter a valid email address";
    }
    if (!invoiceNumber.trim()) next.invoiceNumber = "Invoice number is required";
    const cents = dollarsToCents(amountDollars);
    if (cents === null) next.amount = "Enter an amount greater than 0";
    return Object.keys(next).length > 0 ? next : null;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    const cents = dollarsToCents(amountDollars);
    if (cents === null) return;

    const input: CreateInvoiceInput = {
      vendorName: vendorName.trim(),
      vendorEmail: vendorEmail.trim(),
      invoiceNumber: invoiceNumber.trim(),
      amountCents: cents,
      currencyCode,
      ...(dueDate ? { dueDate } : {}),
      ...(expectedMcc ? { expectedMcc } : {}),
    };
    createMutation.mutate(input);
  }

  const submitError =
    createMutation.error instanceof Error ? createMutation.error.message : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-invoice-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="create-invoice-title" className="text-lg font-semibold text-gray-900">
            New invoice
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {submitError && (
          <div className="mb-4">
            <ErrorMessage message={submitError} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field
            id="vendorName"
            label="Vendor name"
            value={vendorName}
            onChange={setVendorName}
            error={errors.vendorName}
            placeholder="Acme Supplies"
            required
          />
          <Field
            id="vendorEmail"
            label="Vendor email"
            type="email"
            value={vendorEmail}
            onChange={setVendorEmail}
            error={errors.vendorEmail}
            placeholder="billing@acme.com"
            required
          />
          <Field
            id="invoiceNumber"
            label="Invoice number"
            value={invoiceNumber}
            onChange={setInvoiceNumber}
            error={errors.invoiceNumber}
            placeholder="INV-001"
            required
          />

          <div className="grid grid-cols-2 gap-3">
            <Field
              id="amount"
              label="Amount"
              type="number"
              step="0.01"
              min="0.01"
              value={amountDollars}
              onChange={setAmountDollars}
              error={errors.amount}
              placeholder="0.00"
              required
            />
            <div>
              <label
                htmlFor="currencyCode"
                className="block text-sm font-medium text-gray-700"
              >
                Currency
              </label>
              <select
                id="currencyCode"
                value={currencyCode}
                onChange={(e) =>
                  setCurrencyCode(e.target.value as SupportedCurrencyCode)
                }
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {Object.values(SupportedCurrency).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Field
            id="dueDate"
            label="Due date (optional)"
            type="date"
            value={dueDate}
            onChange={setDueDate}
          />
          <Field
            id="expectedMcc"
            label="Expected MCC (optional)"
            value={expectedMcc}
            onChange={setExpectedMcc}
            placeholder="5411"
            pattern="\d{4}"
            inputMode="numeric"
          />

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              disabled={createMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating..." : "Create invoice"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  error?: string;
  required?: boolean;
  step?: string;
  min?: string;
  pattern?: string;
  inputMode?: "numeric" | "text" | "email";
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  error,
  required,
  step,
  min,
  pattern,
  inputMode,
}: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        step={step}
        min={min}
        pattern={pattern}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
            : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500"
        }`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
