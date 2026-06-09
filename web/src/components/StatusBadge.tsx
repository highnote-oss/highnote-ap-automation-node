interface StatusBadgeProps {
  status: string;
}

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  SUSPENDED: "bg-amber-100 text-amber-800",
  CLOSED: "bg-gray-100 text-gray-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  ACTIVATION_REQUIRED: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  COMPLETED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  DENIED: "bg-red-100 text-red-800",
  IN_REVIEW: "bg-indigo-100 text-indigo-800",
  IN_PROGRESS: "bg-indigo-100 text-indigo-800",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = statusStyles[status] || "bg-gray-100 text-gray-800";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
