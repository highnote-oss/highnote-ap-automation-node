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

/** Friendly labels for the SDK's `onCopyToClipboardSuccess` field identifiers. */
const FIELD_LABELS: Record<string, string> = {
  cardNumber: "Card number",
  cvv: "CVV",
  expirationDate: "Expiry",
};

const FIELD_HOST_IDS = [
  "ap-viewer-card-number",
  "ap-viewer-expiry",
  "ap-viewer-cvv",
] as const;

/**
 * Force the cross-origin SDK iframes to repaint. Some browsers leave the iframe
 * content unrastered after it finishes loading — the value only appears once a
 * hover / scroll / resize invalidates the region.
 *
 * Each call TOGGLES the iframe height by 1px (33px ⇄ the 32px class value).
 * Resizing forces the embedded document to re-layout and raster. The toggle is
 * the important part: a synchronous set-then-revert is coalesced by the browser
 * to a no-op (start == end) and never repaints — which is exactly why the first
 * attempt failed. By flipping the value and holding it until the next sweep,
 * each state is actually painted. The height normally comes from a Tailwind
 * `!important` class, so we override inline (33px) and remove the override to
 * fall back to it (32px). Sweeps are scheduled an even number of times so we
 * settle back on the class height.
 */
function forceIframeRepaint() {
  for (const id of FIELD_HOST_IDS) {
    const iframe = document.getElementById(id)?.querySelector("iframe");
    if (!(iframe instanceof HTMLIFrameElement)) continue;
    if (iframe.style.getPropertyValue("height") === "33px") {
      iframe.style.removeProperty("height");
    } else {
      iframe.style.setProperty("height", "33px", "important");
    }
  }
}

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
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const toggleMaskRef = useRef<(() => void) | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        // Per-field styling applied inside the SDK iframes. `cursor: pointer`
        // advertises the click-to-copy affordance (clipboard is enabled below).
        const fieldStyles = {
          fontSize: "0.95rem",
          color: "#111827",
          cursor: "pointer",
        };
        const { unmount, toggleCardNumberMask } = await renderFields({
          clientToken: resolvedTokenValue,
          paymentCardId,
          environment: "test",
          // Click a field to copy its value to the clipboard. Enabled by
          // default in the SDK; set explicitly for intent.
          enableClipboard: true,
          onCopyToClipboardSuccess: ({ field }) => {
            if (cancelled) return;
            setCopiedField(field);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => setCopiedField(null), 1500);
          },
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
            cardNumber: {
              selector: "#ap-viewer-card-number",
              styles: {
                ...fieldStyles,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                letterSpacing: "0.05em",
              },
            },
            cvv: { selector: "#ap-viewer-cvv", styles: fieldStyles },
            expirationDate: { selector: "#ap-viewer-expiry", styles: fieldStyles },
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

  // Clear any pending "copied" reset timer when the component unmounts.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Once the fields are ready, force the SDK iframes to repaint. The cvv/expiry
  // values can otherwise stay blank until the user hovers (the browser doesn't
  // raster the freshly-loaded cross-origin iframe content on its own). We sweep
  // across a ~1.5s window because the values can paint slightly after onReady,
  // and each sweep must hold its nudge long enough to be painted (see
  // forceIframeRepaint).
  useEffect(() => {
    if (status !== "ready") return;
    // Even number of sweeps so the height settles back on the class value.
    const sweepDelays = [0, 120, 300, 600, 1000, 1500];
    const timers = sweepDelays.map((ms) => setTimeout(forceIframeRepaint, ms));
    return () => timers.forEach(clearTimeout);
  }, [status, mountKey]);

  function handleToggleMask() {
    toggleMaskRef.current?.();
    setMasked((prev) => !prev);
  }

  // Render the SDK iframes into a container that is laid out and painted from
  // "loading" onward — NOT display:none. Hiding the host with `hidden` until
  // "ready" makes the cross-origin iframes load inside a display:none subtree,
  // which compounds the blank-until-hover problem. Keeping it visible is
  // necessary but NOT sufficient on its own: the iframes still need an explicit
  // repaint nudge once loaded (see forceIframeRepaint) to reliably show the
  // values without a hover.
  const fieldsVisible = status === "loading" || status === "ready";

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
          <div className="flex items-center gap-3">
            {copiedField && (
              <span className="text-xs font-medium text-green-600" role="status">
                Copied {FIELD_LABELS[copiedField] ?? copiedField}
              </span>
            )}
            <button
              type="button"
              onClick={handleToggleMask}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              {masked ? "Show number" : "Hide number"}
            </button>
          </div>
        )}
      </div>

      {status === "loading" && <LoadingSpinner message="Decrypting card..." />}
      {status === "error" && error && <ErrorMessage message={error} />}

      {/*
        Iframe sizing notes:
        - The SDK doesn't set an iframe height, so the browser falls back to
          the HTML default of 150px. The value renders near the top and the
          rest is dead space — that's the "weird tall boxes" look.
        - The SDK's per-field `styles` prop only allows typographic props
          (fontSize, lineHeight, color, …) — not height/padding — so it
          can't shrink the box. The only lever is the iframe element's
          height, which we override from the outside to h-7 (28px), paired
          with tight py-1 wrapper padding for a compact field.
        - The value is top-aligned in the iframe (~10px offset). 28px is about
          as short as it goes before the value clips (verified against SDK
          1.4.2). Width is overridden to 100% so each field fills its column.
      */}
      <div className={fieldsVisible ? "max-w-xs" : "hidden"}>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500">Card number</label>
            <div
              id="ap-viewer-card-number"
              className="mt-1 rounded-md border border-gray-200 px-2 py-1 [&_iframe]:!h-7 [&_iframe]:!w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500">Expiry</label>
              <div
                id="ap-viewer-expiry"
                className="mt-1 rounded-md border border-gray-200 px-2 py-1 [&_iframe]:!h-7 [&_iframe]:!w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500">CVV</label>
              <div
                id="ap-viewer-cvv"
                className="mt-1 rounded-md border border-gray-200 px-2 py-1 [&_iframe]:!h-7 [&_iframe]:!w-full"
              />
            </div>
          </div>
          {status === "ready" && (
            <p className="text-xs text-gray-400">
              Click any field to copy it to your clipboard.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
