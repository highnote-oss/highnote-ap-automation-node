import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type CollabAuthDecision,
  type WebhookEvent,
} from "../api/client";
import { LoadingSpinner } from "./LoadingSpinner";
import { ErrorMessage } from "./ErrorMessage";

interface ActivityFeedProps {
  invoiceId: string;
}

type FeedRow =
  | { kind: "decision"; receivedAt: string; data: CollabAuthDecision }
  | { kind: "event"; receivedAt: string; data: WebhookEvent };

function rowKey(row: FeedRow): string {
  return `${row.kind}-${row.data.id}`;
}

export function ActivityFeed({ invoiceId }: ActivityFeedProps) {
  const decisionsQuery = useQuery({
    queryKey: ["collab-decisions", invoiceId],
    queryFn: () => api.invoices.collabAuthDecisions(invoiceId),
  });

  const eventsQuery = useQuery({
    queryKey: ["webhook-events", invoiceId],
    queryFn: () => api.invoices.webhookEvents(invoiceId),
  });

  const rows = useMemo<FeedRow[]>(() => {
    const decisionRows: FeedRow[] = (decisionsQuery.data ?? []).map((d) => ({
      kind: "decision",
      receivedAt: d.receivedAt,
      data: d,
    }));
    const eventRows: FeedRow[] = (eventsQuery.data ?? []).map((e) => ({
      kind: "event",
      receivedAt: e.receivedAt,
      data: e,
    }));
    return [...decisionRows, ...eventRows].sort((a, b) =>
      a.receivedAt < b.receivedAt ? 1 : -1,
    );
  }, [decisionsQuery.data, eventsQuery.data]);

  const isLoading = decisionsQuery.isPending || eventsQuery.isPending;
  const error =
    decisionsQuery.error instanceof Error
      ? decisionsQuery.error.message
      : eventsQuery.error instanceof Error
        ? eventsQuery.error.message
        : null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-900">Activity</h3>

      {isLoading && <LoadingSpinner message="Loading activity..." />}
      {!isLoading && error && <ErrorMessage message={error} />}
      {!isLoading && !error && rows.length === 0 && (
        <p className="text-sm text-gray-500">No activity yet.</p>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {rows.map((row) => (
            <ActivityRow key={rowKey(row)} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ActivityRowProps {
  row: FeedRow;
}

function ActivityRow({ row }: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const title = rowTitle(row);
  const subtitle = rowSubtitle(row);
  const badge = rowBadge(row);

  return (
    <li className="py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 text-left"
        aria-expanded={expanded}
      >
        <span
          className={`mt-0.5 inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
        <span className="flex-1">
          <span className="block text-sm font-medium text-gray-900">{title}</span>
          {subtitle && (
            <span className="block text-xs text-gray-500">{subtitle}</span>
          )}
          <span className="mt-0.5 block text-xs text-gray-400">
            {new Date(row.receivedAt).toLocaleString()}
          </span>
        </span>
        <span className="mt-0.5 text-xs text-gray-400">
          {expanded ? "Hide" : "Show"} payload
        </span>
      </button>
      {expanded && (
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-50 p-3 text-xs text-gray-700">
          {prettyPayload(row)}
        </pre>
      )}
    </li>
  );
}

function rowTitle(row: FeedRow): string {
  if (row.kind === "decision") {
    return `Collab Auth — ${row.data.decision}`;
  }
  return row.data.eventType;
}

function rowSubtitle(row: FeedRow): string | null {
  if (row.kind === "decision") {
    return row.data.reason ?? null;
  }
  return row.data.eventId ?? null;
}

function rowBadge(row: FeedRow): { label: string; className: string } {
  if (row.kind === "decision") {
    return {
      label: "CA",
      className: "bg-indigo-100 text-indigo-800",
    };
  }
  return {
    label: "WH",
    className: "bg-emerald-100 text-emerald-800",
  };
}

function prettyPayload(row: FeedRow): string {
  const raw =
    row.kind === "decision" ? row.data.rawPayload : row.data.payload;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
