import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type Invoice, type PayLinkResponse } from "../api/client";
import { LoadingSpinner } from "./LoadingSpinner";
import { ErrorMessage } from "./ErrorMessage";

interface SendToVendorModalProps {
  invoice: Invoice;
  onClose: () => void;
}

const COPY_FEEDBACK_MS = 2000;

export function SendToVendorModal({ invoice, onClose }: SendToVendorModalProps) {
  const startedRef = useRef(false);

  const payLinkMutation = useMutation<PayLinkResponse, Error>({
    mutationFn: () => api.invoices.payLink(invoice.id),
  });

  // Auto-fire the mutation on open. `useRef` prevents Strict-Mode's double
  // invoke from minting two slugs in development.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    payLinkMutation.mutate();
  }, [payLinkMutation]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
        aria-labelledby="send-to-vendor-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="send-to-vendor-title"
            className="text-lg font-semibold text-gray-900"
          >
            Send to vendor
          </h2>
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

        {payLinkMutation.isPending && (
          <LoadingSpinner message="Generating pay link..." />
        )}

        {payLinkMutation.isError && (
          <ErrorMessage message={payLinkMutation.error.message} />
        )}

        {payLinkMutation.isSuccess && (
          <PayLinkBody invoice={invoice} payLink={payLinkMutation.data} />
        )}
      </div>
    </div>
  );
}

interface PayLinkBodyProps {
  invoice: Invoice;
  payLink: PayLinkResponse;
}

function PayLinkBody({ invoice, payLink }: PayLinkBodyProps) {
  const [copied, setCopied] = useState(false);
  const fullUrl = `${window.location.origin}/pay/${payLink.slug}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Fall through silently — the URL is shown in a readable input the
      // vendor can copy manually if the clipboard API is unavailable.
    }
  }

  const mailto = buildMailto(invoice, fullUrl);

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="pay-link-url"
          className="block text-xs font-medium text-gray-500"
        >
          Pay link URL
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="pay-link-url"
            type="text"
            readOnly
            value={fullUrl}
            className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-800"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        Link expires {formatExpiry(payLink.expiresAt)}.
      </p>

      <div className="flex justify-end gap-2 pt-2">
        <a
          href={mailto}
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Open in mail client
        </a>
      </div>
    </div>
  );
}

function buildMailto(invoice: Invoice, payUrl: string): string {
  const subject = `Invoice ${invoice.invoiceNumber} payment link`;
  const body = [
    `Hi ${invoice.vendorName},`,
    "",
    `Please use the link below to collect payment for invoice ${invoice.invoiceNumber}:`,
    "",
    payUrl,
    "",
    "Thanks!",
  ].join("\n");
  const params = new URLSearchParams({ subject, body });
  return `mailto:${encodeURIComponent(invoice.vendorEmail)}?${params.toString()}`;
}

function formatExpiry(expiresAt: string): string {
  const target = new Date(expiresAt).getTime();
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "soon";
  const hours = Math.round(diffMs / (1000 * 60 * 60));
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(diffMs / (1000 * 60)));
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
