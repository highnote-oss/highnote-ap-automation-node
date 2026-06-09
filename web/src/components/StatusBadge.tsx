import type { InvoiceStatus } from "../api/client";

interface StatusBadgeProps {
  status: string;
}

const invoiceStatusStyles: Record<InvoiceStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-800",
  APPROVED: "bg-green-100 text-green-800",
  CARD_ISSUED: "bg-blue-100 text-blue-800",
  AUTHORIZED: "bg-indigo-100 text-indigo-800",
  CLEARED: "bg-emerald-100 text-emerald-800",
  RECONCILED: "bg-teal-100 text-teal-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const genericStatusStyles: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  SUSPENDED: "bg-amber-100 text-amber-800",
  CLOSED: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  ACTIVATION_REQUIRED: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  DENIED: "bg-red-100 text-red-800",
  IN_REVIEW: "bg-indigo-100 text-indigo-800",
  IN_PROGRESS: "bg-indigo-100 text-indigo-800",
};

function styleFor(status: string): string {
  if (status in invoiceStatusStyles) {
    return invoiceStatusStyles[status as InvoiceStatus];
  }
  return genericStatusStyles[status] ?? "bg-gray-100 text-gray-800";
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = styleFor(status);

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
