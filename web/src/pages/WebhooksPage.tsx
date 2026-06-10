import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import {
  api,
  type WebhookEvent,
  type WebhooksStatus,
} from "../api/client";
import { NavBar } from "../components/NavBar";
import { PageHeader } from "../components/PageHeader";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorMessage } from "../components/ErrorMessage";
import { EmptyState } from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";

const WEBHOOKS_STATUS_KEY = ["webhooks", "status"] as const;
const WEBHOOKS_EVENTS_KEY = ["webhooks", "events"] as const;
const REFRESH_INTERVAL_MS = 10_000;

export function WebhooksPage() {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-slate-100">
      <NavBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-start justify-between">
          <PageHeader title="Webhooks" subtitle="Inbound events from Highnote" />
          <RefreshButton />
        </div>

        <StatusCard />
        <EventsSection />
      </main>
    </div>
  );
}

function RefreshButton() {
  const queryClient = useQueryClient();

  function refresh() {
    queryClient.invalidateQueries({ queryKey: WEBHOOKS_STATUS_KEY });
    queryClient.invalidateQueries({ queryKey: WEBHOOKS_EVENTS_KEY });
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
  const statusQuery = useQuery<WebhooksStatus>({
    queryKey: WEBHOOKS_STATUS_KEY,
    queryFn: api.webhooks.status,
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
              : "Failed to load webhook status"
          }
        />
      </div>
    );
  }

  const status = statusQuery.data;

  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          Webhook target
        </h2>
        <StatusBadge status={status.status} />
      </header>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Row label="Target name" value={status.name ?? "—"} />
        <Row label="Endpoint URI" value={status.publicUrl ?? "—"} mono />
        <Row
          label="Signing key"
          value={status.hasSecret ? "Held in memory" : "Missing"}
          accent={status.hasSecret ? "good" : "bad"}
        />
        <Row label="Subscriptions" value={String(status.subscriptionCount)} />
        <Row
          label="Registered at"
          value={
            status.registeredAt
              ? new Date(status.registeredAt).toLocaleString()
              : "—"
          }
        />
        <Row label="Source" value={status.source} />
      </dl>

      {status.lastError && (
        <p className="mt-3 text-xs text-red-600">
          Last error: {status.lastError}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end">
        <ReregisterButton />
      </div>
    </section>
  );
}

function ReregisterButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation<WebhooksStatus, Error>({
    mutationFn: api.webhooks.register,
    onSuccess: (data) => {
      queryClient.setQueryData(WEBHOOKS_STATUS_KEY, data);
      queryClient.invalidateQueries({ queryKey: WEBHOOKS_EVENTS_KEY });
    },
  });

  return (
    <div className="flex items-center gap-3">
      {mutation.isError && (
        <span className="text-xs text-red-600">
          {mutation.error.message}
        </span>
      )}
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="rounded-lg border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
        title="Remove any prior auto-registered notification target and register a fresh one with Highnote."
      >
        {mutation.isPending ? "Re-registering..." : "Re-register"}
      </button>
    </div>
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
        className={`mt-0.5 ${mono ? "font-mono text-xs" : "text-sm"} ${accentClass}`}
      >
        {value}
      </dd>
    </div>
  );
}

function EventsSection() {
  const eventsQuery = useQuery<WebhookEvent[]>({
    queryKey: WEBHOOKS_EVENTS_KEY,
    queryFn: () => api.webhooks.events(),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  if (eventsQuery.isPending) {
    return <LoadingSpinner message="Loading events..." />;
  }

  if (eventsQuery.isError) {
    return (
      <ErrorMessage
        message={
          eventsQuery.error instanceof Error
            ? eventsQuery.error.message
            : "Failed to load webhook events"
        }
      />
    );
  }

  if (eventsQuery.data.length === 0) {
    return <EmptyState message="No webhook events yet." />;
  }

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <Th>Received</Th>
            <Th>Event type</Th>
            <Th>Invoice</Th>
            <Th>Event ID</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {eventsQuery.data.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface EventRowProps {
  event: WebhookEvent;
}

function EventRow({ event }: EventRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="hover:bg-gray-50">
        <Td>{new Date(event.receivedAt).toLocaleString()}</Td>
        <Td>
          <span className="inline-flex items-center rounded bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
            {event.eventType}
          </span>
        </Td>
        <Td>
          {event.invoiceId ? (
            <Link
              to={`/invoices/${event.invoiceId}`}
              className="font-mono text-xs text-indigo-600 hover:text-indigo-800"
            >
              {event.invoiceId.slice(0, 8)}…
            </Link>
          ) : (
            <span className="text-xs text-gray-400">—</span>
          )}
        </Td>
        <Td className="font-mono text-xs text-gray-500">
          {event.eventId ?? "—"}
        </Td>
        <Td className="text-right">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            {expanded ? "Hide payload" : "Show payload"}
          </button>
        </Td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50">
          <td colSpan={5} className="px-4 py-3">
            <pre className="max-h-72 overflow-auto rounded-md bg-white p-3 text-xs text-gray-700 ring-1 ring-gray-200">
              {prettyJson(event.payload)}
            </pre>
          </td>
        </tr>
      )}
    </>
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
