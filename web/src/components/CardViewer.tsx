import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { LoadingSpinner } from "./LoadingSpinner";
import { ErrorMessage } from "./ErrorMessage";

interface CardViewerProps {
  invoiceId: string;
  paymentCardId: string;
  /**
   * Pre-fetched client token value. When supplied, the component skips the
   * authed `api.invoices.cardViewerToken(invoiceId)` fetch and uses this
   * value directly. The public pay-by-link page passes the token obtained
   * via `GET /api/pay/:slug` — which has no JWT, so the authed fetch path
   * would fail.
   */
  clientTokenValue?: string;
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
export function CardViewer({
  invoiceId,
  paymentCardId,
  clientTokenValue,
}: CardViewerProps) {
  const tokenQuery = useQuery({
    queryKey: ["card-viewer-token", invoiceId],
    queryFn: () => api.invoices.cardViewerToken(invoiceId),
    // Don't auto-refresh; this token is single-use for the iframe.
    staleTime: Infinity,
    retry: false,
    // Skip the authed fetch entirely when the caller supplied a token. The
    // public pay-by-link page has no JWT, so triggering the authed query
    // would surface a 401 to vendors.
    enabled: clientTokenValue === undefined,
  });

  const resolvedTokenValue = clientTokenValue ?? tokenQuery.data?.value;

  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [masked, setMasked] = useState(true);
  const [mountKey, setMountKey] = useState(0);
  const toggleMaskRef = useRef<(() => void) | null>(null);

  // The SDK has an internal race: the cardNumber iframe broadcasts
  // PAYMENT_CARD_DATA_READY to siblings via postMessage immediately after its
  // GraphQL fetch. Sibling iframes need to have already executed renderField()
  // and attached their message listener by the time the broadcast arrives.
  // Browsers do not queue postMessage events for windows that aren't listening
  // yet, so a cached/fast-network response can fire the broadcast before
  // siblings settle and the cvv / expiry values never paint.
  //
  // We detect this by listening for CARD_VIEWER_READY via the onReady callback
  // and retrying the mount if it doesn't fire within READY_TIMEOUT_MS. Each
  // retry bumps `mountKey` which restarts the effect.
  const READY_TIMEOUT_MS = 3000;
  const MAX_RETRIES = 3;
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!resolvedTokenValue) return;

    // Track whether this effect run is still relevant. StrictMode in dev runs
    // mount → cleanup → re-mount; we need to know in the cleanup whether the
    // async `renderFields` from this run has resolved yet, and in the async
    // path whether the effect has already been torn down.
    let cancelled = false;
    let pendingUnmount: (() => Promise<void>) | null = null;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;
    let ready = false;

    (async () => {
      setStatus("loading");
      setError(null);
      try {
        const { renderFields } = await import("@highnoteplatform/card-viewer");
        if (cancelled) return;
        // Yield a paint frame so React commits the container divs before the
        // SDK queries for them via `selector`.
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        const { unmount, toggleCardNumberMask } = await renderFields({
          clientToken: resolvedTokenValue,
          paymentCardId,
          environment: "test",
          onError: (err: CardViewerError) => {
            if (cancelled) return;
            setError(err?.message ?? "Failed to load card details");
            setStatus("error");
          },
          onReady: () => {
            ready = true;
            if (readyTimeout) {
              clearTimeout(readyTimeout);
              readyTimeout = null;
            }
            // Reset retry counter on success so a later remount (e.g. after
            // a stale-card refresh) gets a fresh budget.
            retryCountRef.current = 0;
          },
          elements: {
            cardNumber: { selector: "#ap-viewer-card-number" },
            cvv: { selector: "#ap-viewer-cvv" },
            expirationDate: { selector: "#ap-viewer-expiry" },
          },
        });
        // Effect was torn down (e.g. StrictMode cleanup) while renderFields was
        // in flight. Unmount immediately so we don't leak an orphan iframe and
        // don't update state on a torn-down component.
        if (cancelled) {
          void unmount();
          return;
        }
        pendingUnmount = unmount;
        toggleMaskRef.current = toggleCardNumberMask;
        setStatus("ready");

        // Watchdog: if onReady didn't fire by now, the postMessage race lost.
        // Unmount and bump mountKey to trigger a fresh attempt.
        readyTimeout = setTimeout(() => {
          if (ready || cancelled) return;
          if (retryCountRef.current >= MAX_RETRIES) {
            setError(
              "Card viewer did not finish loading after several attempts. Refresh the page to retry.",
            );
            setStatus("error");
            return;
          }
          retryCountRef.current += 1;
          if (pendingUnmount) {
            void pendingUnmount();
            pendingUnmount = null;
          }
          setMountKey((k) => k + 1);
        }, READY_TIMEOUT_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load card viewer");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      toggleMaskRef.current = null;
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = null;
      }
      if (pendingUnmount) {
        void pendingUnmount();
        pendingUnmount = null;
      }
    };
  }, [paymentCardId, resolvedTokenValue, mountKey]);

  function handleToggleMask() {
    toggleMaskRef.current?.();
    setMasked((prev) => !prev);
  }

  // Only surface the authed query's pending/error states when we actually
  // depend on it. When the caller supplied a token, the query is disabled
  // and `isPending` would otherwise stick true forever.
  if (clientTokenValue === undefined && tokenQuery.isPending) {
    return <LoadingSpinner message="Loading card details..." />;
  }
  if (clientTokenValue === undefined && tokenQuery.isError) {
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

      {/*
        Iframe sizing notes:
        - The SDK injects iframes with `width: 300px; height: 150px` defaults
          and positions the value somewhere in that area (likely vertically
          centered). Forcing the iframe to a small height via Tailwind's
          arbitrary-value + !important clipped the value below the visible
          slice; to the operator that looked like "CVV and expiry only
          appear on hover" because the iframe's internal styling shifted
          the visible portion in response to hover/focus.
        - We let each iframe render at the SDK's natural height now so the
          value is always visible. Width is overridden to 100% so each
          field fills its column. The visual is taller than the earlier
          compact look; if a denser layout is needed, the right path is
          to pass `styles: { lineHeight, fontSize }` into renderFields
          instead of clamping the iframe height from the outside.
      */}
      <div className={status === "ready" ? "" : "hidden"}>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500">Card number</label>
            <div
              id="ap-viewer-card-number"
              className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Expiry</label>
              <div
                id="ap-viewer-expiry"
                className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">CVV</label>
              <div
                id="ap-viewer-cvv"
                className="mt-1 rounded-md border border-gray-200 p-2 [&_iframe]:!w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
