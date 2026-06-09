import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  type CollabAuthDecision,
  type CollabAuthStatus,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { formatCents } from "../utils/money";

const STATUS_KEY = ["collab-auth", "status"] as const;
const DECISIONS_KEY = ["collab-auth", "decisions"] as const;
const REFRESH_INTERVAL_MS = 10_000;

// CA response code from the SDK indicating an approval. Mirror of the
// `CollaborativeAuthorizationResponseCode.APPROVED` enum member. The web
// package does not import the SDK; we compare by string value.
const APPROVED_DECISION = "APPROVED";

export function CollabAuthPage() {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-start justify-between">
          <PageHeader
            title="Collaborative Auth"
            subtitle="Real-time authorization decisions"
          />
          <RefreshButton />
        </div>

        <StatusCard />
        <DecisionsSection />
      </main>
    </div>
  );
}

function RefreshButton() {
  const queryClient = useQueryClient();

  function refresh() {
    queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    queryClient.invalidateQueries({ queryKey: DECISIONS_KEY });
  }

  return (
    <button
      type="button"
      onClick={refresh}
      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
    >
      Refresh
    </button>
  );
}

function StatusCard() {
  const statusQuery = useQuery<CollabAuthStatus>({
    queryKey: STATUS_KEY,
    queryFn: api.collabAuth.status,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  if (statusQuery.isPending) {
    return (
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <LoadingSpinner message="Loading registration status..." />
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div className="mb-6">
        <ErrorMessage
          message={
            statusQuery.error instanceof Error
              ? statusQuery.error.message
              : "Failed to load CA status"
          }
        />
      </div>
    );
  }

  const status = statusQuery.data;

  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">CA endpoint</h2>
        <StatusBadge status={status.status} />
      </header>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Row label="Endpoint name" value={status.name ?? "—"} />
        <Row label="URI" value={status.publicUrl ?? "—"} mono />
        <Row
          label="Signing key"
          value={status.hasSigningKey ? "Held in memory" : "Missing"}
          accent={status.hasSigningKey ? "good" : "bad"}
        />
        <Row label="Source" value={status.source} />
        <Row
          label="Registered at"
          value={
            status.registeredAt
              ? new Date(status.registeredAt).toLocaleString()
              : "—"
          }
        />
        <Row label="Endpoint ID" value={status.endpointId ?? "—"} mono />
      </dl>

      {status.lastError && (
        <p className="mt-3 text-xs text-red-600">
          Last error: {status.lastError}
        </p>
      )}
    </section>
  );
}

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "good" | "bad";
}

function Row({ label, value, mono, accent }: RowProps) {
  const accentClass =
    accent === "good"
      ? "text-emerald-700"
      : accent === "bad"
        ? "text-red-700"
        : "text-gray-900";
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd
        className={`mt-0.5 break-all ${mono ? "font-mono text-xs" : "text-sm"} ${accentClass}`}
      >
        {value}
      </dd>
    </div>
  );
}

function DecisionsSection() {
  const decisionsQuery = useQuery<CollabAuthDecision[]>({
    queryKey: DECISIONS_KEY,
    queryFn: () => api.collabAuth.decisions(),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  if (decisionsQuery.isPending) {
    return <LoadingSpinner message="Loading decisions..." />;
  }

  if (decisionsQuery.isError) {
    return (
      <ErrorMessage
        message={
          decisionsQuery.error instanceof Error
            ? decisionsQuery.error.message
            : "Failed to load decisions"
        }
      />
    );
  }

  if (decisionsQuery.data.length === 0) {
    return (
      <EmptyState message="No CA decisions yet. Use Simulate to trigger one." />
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <Th>Received</Th>
            <Th>Invoice</Th>
            <Th>Card</Th>
            <Th>Decision</Th>
            <Th>Reason</Th>
            <Th>Amount</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {decisionsQuery.data.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface DecisionRowProps {
  decision: CollabAuthDecision;
}

function DecisionRow({ decision }: DecisionRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="hover:bg-gray-50">
        <Td>{new Date(decision.receivedAt).toLocaleString()}</Td>
        <Td>
          {decision.invoiceId ? (
            <Link
              to={`/invoices/${decision.invoiceId}`}
              className="font-mono text-xs text-indigo-600 hover:text-indigo-800"
            >
              {decision.invoiceId.slice(0, 8)}…
            </Link>
          ) : (
            <span className="text-xs text-gray-400">—</span>
          )}
        </Td>
        <Td className="font-mono text-xs text-gray-500">
          {decision.paymentCardId.slice(0, 12)}…
        </Td>
        <Td>
          <DecisionBadge decision={decision.decision} />
        </Td>
        <Td className="text-xs text-gray-600">{decision.reason ?? "—"}</Td>
        <Td>{formatCents(decision.requestedAmountCents, "USD")}</Td>
        <Td className="text-right">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            {expanded ? "Hide" : "Show"}
          </button>
        </Td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={7} className="px-4 py-3">
            <pre className="max-h-72 overflow-auto rounded-md bg-white p-3 text-xs text-gray-700 ring-1 ring-gray-200">
              {prettyJson(decision.rawPayload)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

interface DecisionBadgeProps {
  decision: string;
}

function DecisionBadge({ decision }: DecisionBadgeProps) {
  const isApproved = decision === APPROVED_DECISION;
  const className = isApproved
    ? "bg-emerald-100 text-emerald-800"
    : "bg-red-100 text-red-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {decision.replace(/_/g, " ")}
    </span>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
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
    <td className={`px-4 py-3 align-top text-sm text-gray-700 ${className}`}>
      {children}
    </td>
  );
}
