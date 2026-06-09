import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { LoadingSpinner } from "./LoadingSpinner";
import { ErrorMessage } from "./ErrorMessage";

interface CardViewerProps {
  invoiceId: string;
  paymentCardId: string;
}

type ViewerStatus = "idle" | "loading" | "ready" | "error";

interface CardViewerError {
  message?: string;
  name?: string;
}

/**
 * Embeds the Highnote `@highnoteplatform/card-viewer` SDK to render the
 * sensitive card-number / expiry / CVV fields for an issued invoice card.
 *
 * The SDK is loaded via dynamic `import()` so the iframe runtime is split out
 * of the SPA's initial chunk — only this page (and only when an issued card
 * exists) pays the download cost.
 *
 * The client token returned by the backend is the raw Highnote `ClientToken`
 * shape (`{ value, expirationDate }`); the SDK's `clientToken` field takes
 * `value`. Cleanup runs the SDK's `unmount` on every unmount + on token
 * refresh so we never leave a stale iframe in the DOM.
 */
export function CardViewer({ invoiceId, paymentCardId }: CardViewerProps) {
  const tokenQuery = useQuery({
    queryKey: ["card-viewer-token", invoiceId],
    queryFn: () => api.invoices.cardViewerToken(invoiceId),
    // Don't auto-refresh; this token is single-use for the iframe.
    staleTime: Infinity,
    retry: false,
  });

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [masked, setMasked] = useState(true);
  const unmountRef = useRef<(() => Promise<void>) | null>(null);
  const toggleMaskRef = useRef<(() => void) | null>(null);

  const mount = useCallback(async (clientTokenValue: string): Promise<void> => {
    setStatus("loading");
    setError(null);
    try {
      const { renderFields } = await import("@highnoteplatform/card-viewer");
      // Yield a paint frame so React commits the container divs before the
      // SDK queries for them via `selector`.
      await new Promise((r) => setTimeout(r, 0));
      const { unmount, toggleCardNumberMask } = await renderFields({
        clientToken: clientTokenValue,
        paymentCardId,
        environment: "test",
        onError: (err: CardViewerError) => {
          setError(err?.message ?? "Failed to load card details");
          setStatus("error");
        },
        elements: {
          cardNumber: { selector: "#ap-viewer-card-number" },
          cvv: { selector: "#ap-viewer-cvv" },
          expirationDate: { selector: "#ap-viewer-expiry" },
        },
      });
      unmountRef.current = unmount;
      toggleMaskRef.current = toggleCardNumberMask;
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load card viewer");
      setStatus("error");
    }
  }, [paymentCardId]);

  useEffect(() => {
    if (!tokenQuery.data) return;
    void mount(tokenQuery.data.value);
    return () => {
      toggleMaskRef.current = null;
      if (unmountRef.current) {
        void unmountRef.current();
        unmountRef.current = null;
      }
    };
  }, [mount, tokenQuery.data]);

  function handleToggleMask() {
    toggleMaskRef.current?.();
    setMasked((prev) => !prev);
  }

  if (tokenQuery.isPending) {
    return <LoadingSpinner message="Loading card details..." />;
  }
  if (tokenQuery.isError) {
    return (
      <ErrorMessage
        message={
          tokenQuery.error instanceof Error
            ? tokenQuery.error.message
            : "Failed to load card token"
        }
      />
    );
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Virtual card</h3>
        {status === "ready" && (
          <button
            type="button"
            onClick={handleToggleMask}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            {masked ? "Show number" : "Hide number"}
          </button>
        )}
      </div>

      {status === "loading" && <LoadingSpinner message="Decrypting card..." />}
      {status === "error" && error && <ErrorMessage message={error} />}

      <div className={status === "ready" ? "" : "hidden"}>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500">Card number</label>
            <div
              id="ap-viewer-card-number"
              className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!h-[24px] [&_iframe]:!w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Expiry</label>
              <div
                id="ap-viewer-expiry"
                className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!h-[24px] [&_iframe]:!w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">CVV</label>
              <div
                id="ap-viewer-cvv"
                className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!h-[24px] [&_iframe]:!w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
