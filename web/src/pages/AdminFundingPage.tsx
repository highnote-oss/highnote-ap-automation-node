import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  SupportedCurrency,
  type FundingAccount,
  type SupportedCurrencyCode,
  type TopUpInput,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { EmptyState } from "../components/EmptyState";
import { dollarsToCents, formatCents } from "../utils/money";

const FUNDING_ACCOUNTS_QUERY_KEY = ["fundingAccounts"] as const;
const AVAILABLE_CASH_LEDGER_NAME = "AVAILABLE_CASH";
const CARD_FUNDING_FEATURE_TYPENAME = "CardFundingFinancialAccountFeature";

interface DisplayBalance {
  cents: number;
  currencyCode: string;
}

function findAvailableCashBalance(account: FundingAccount): DisplayBalance | null {
  const ledger = account.ledgers?.find(
    (entry) => entry.name === AVAILABLE_CASH_LEDGER_NAME
  );
  if (!ledger) return null;
  const raw = ledger.creditBalance?.value;
  if (raw === undefined || raw === null) return null;
  const numeric = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(numeric)) return null;
  return {
    cents: numeric,
    currencyCode: ledger.creditBalance?.currencyCode ?? SupportedCurrency.USD,
  };
}

function isCardFundingActive(account: FundingAccount): boolean {
  return (
    account.features?.some(
      (feature) =>
        feature.__typename === CARD_FUNDING_FEATURE_TYPENAME &&
        feature.enabled === true
    ) ?? false
  );
}

export function AdminFundingPage() {
  const { user } = useAuth();
  const [topUpTarget, setTopUpTarget] = useState<FundingAccount | null>(null);

  const accountsQuery = useQuery({
    queryKey: FUNDING_ACCOUNTS_QUERY_KEY,
    queryFn: api.fundingAccounts.list,
    enabled: !!user,
  });

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <PageHeader
          title="Funding Accounts"
          subtitle="Top up balances for issuing virtual cards"
        />

        {accountsQuery.isPending && (
          <LoadingSpinner message="Loading funding accounts..." />
        )}

        {accountsQuery.isError && (
          <ErrorMessage
            message={
              accountsQuery.error instanceof Error
                ? accountsQuery.error.message
                : "Failed to load funding accounts"
            }
          />
        )}

        {accountsQuery.isSuccess && accountsQuery.data.length === 0 && (
          <EmptyState message="No funding accounts yet — one will be auto-created the first time you approve and issue a card." />
        )}

        {accountsQuery.isSuccess && accountsQuery.data.length > 0 && (
          <FundingAccountTable
            accounts={accountsQuery.data}
            onTopUp={setTopUpTarget}
          />
        )}
      </main>

      {topUpTarget && (
        <TopUpModal
          account={topUpTarget}
          onClose={() => setTopUpTarget(null)}
          onSuccess={() => setTopUpTarget(null)}
        />
      )}
    </div>
  );
}

interface FundingAccountTableProps {
  accounts: FundingAccount[];
  onTopUp: (account: FundingAccount) => void;
}

function FundingAccountTable({ accounts, onTopUp }: FundingAccountTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <Th>Name</Th>
            <Th>Status</Th>
            <Th>Available Balance</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 bg-white">
          {accounts.map((account) => {
            const balance = findAvailableCashBalance(account);
            const active = isCardFundingActive(account);
            return (
              <tr key={account.id}>
                <Td>
                  <div className="font-medium text-gray-900">
                    {account.name ?? account.id}
                  </div>
                  {account.name && (
                    <div className="text-xs text-gray-500">{account.id}</div>
                  )}
                </Td>
                <Td>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      active
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {active ? "Active" : "—"}
                  </span>
                </Td>
                <Td>
                  {balance
                    ? formatCents(balance.cents, balance.currencyCode)
                    : "—"}
                </Td>
                <Td className="text-right">
                  <button
                    type="button"
                    onClick={() => onTopUp(account)}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
                  >
                    Top up
                  </button>
                </Td>
              </tr>
            );
          })}
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
  return (
    <td className={`px-4 py-3 text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}

interface TopUpModalProps {
  account: FundingAccount;
  onClose: () => void;
  onSuccess: () => void;
}

interface TopUpFormErrors {
  amount?: string;
}

function TopUpModal({ account, onClose, onSuccess }: TopUpModalProps) {
  const queryClient = useQueryClient();
  const [amountDollars, setAmountDollars] = useState("");
  const [currencyCode, setCurrencyCode] = useState<SupportedCurrencyCode>(
    SupportedCurrency.USD
  );
  const [errors, setErrors] = useState<TopUpFormErrors>({});

  const topUpMutation = useMutation({
    mutationFn: (input: TopUpInput) =>
      api.fundingAccounts.topup(account.id, input.amountCents, input.currencyCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FUNDING_ACCOUNTS_QUERY_KEY });
      onSuccess();
    },
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(amountDollars);
    if (cents === null) {
      setErrors({ amount: "Enter an amount greater than 0" });
      return;
    }
    setErrors({});
    topUpMutation.mutate({ amountCents: cents, currencyCode });
  }

  const submitError =
    topUpMutation.error instanceof Error ? topUpMutation.error.message : null;
  const accountLabel = account.name ?? account.id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="topup-title"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="topup-title" className="text-lg font-semibold text-gray-900">
              Top up funding account
            </h2>
            <p className="mt-1 text-xs text-gray-500">{accountLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
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

        {submitError && (
          <div className="mb-4">
            <ErrorMessage message={submitError} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="topup-amount"
                className="block text-sm font-medium text-gray-700"
              >
                Amount
              </label>
              <input
                id="topup-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                placeholder="0.00"
                aria-invalid={errors.amount ? true : undefined}
                required
                className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 ${
                  errors.amount
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500"
                    : "border-gray-300 focus:border-indigo-500 focus:ring-indigo-500"
                }`}
              />
              {errors.amount && (
                <p className="mt-1 text-xs text-red-600">{errors.amount}</p>
              )}
            </div>
            <div>
              <label
                htmlFor="topup-currency"
                className="block text-sm font-medium text-gray-700"
              >
                Currency
              </label>
              <select
                id="topup-currency"
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

          <p className="text-xs text-gray-500">
            Top-up may take a moment to reflect in the balance.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={topUpMutation.isPending}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={topUpMutation.isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {topUpMutation.isPending ? "Topping up..." : "Top up"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
