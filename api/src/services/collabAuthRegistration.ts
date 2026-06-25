/**
 * Collaborative authorization endpoint auto-registration on server start.
 *
 * On Render, registers a fresh CA endpoint with Highnote each deploy and
 * holds the signing key in process memory. The endpoint URL is
 * `{publicUrl}/collaborative-auth`. Only one endpoint can be active at a
 * time, so we remove prior `bay19-auto-*` endpoints before registering
 * fresh — mirroring the webhook-target pattern used by consumer-prepaid.
 *
 * Locally, init() resolves to no public URL and skips registration; the
 * decision-tree handler still works (it just rejects unsigned requests
 * when no signing key is in memory, depending on caller policy).
 */

import { randomUUID } from "node:crypto";
import { highnote } from "./highnote.js";

/**
 * Unique per-process id, echoed by `GET /health`. Used to detect when Render
 * has cut external traffic over to THIS instance during a deploy (see
 * `waitForExternalCutover`).
 */
const BOOT_ID = randomUUID();

/** This process's boot id — surfaced on `/health` for cutover detection. */
export function getBootId(): string {
  return BOOT_ID;
}

export type RegistrationStatus =
  | "NOT_REGISTERED"
  | "PENDING_VERIFICATION"
  | "ACTIVE"
  | "DEACTIVATED"
  | "ACTIVATION_FAILED"
  | "REGISTRATION_FAILED";

export type RegistrationSource = "auto" | "manual" | "none";

interface InternalState {
  endpointId: string | null;
  name: string | null;
  status: RegistrationStatus;
  signingKeySecret: string | null;
  registeredAt: string | null;
  lastError: string | null;
  source: RegistrationSource;
  publicUrl: string | null;
}

export interface PublicStatus {
  endpointId: string | null;
  name: string | null;
  status: RegistrationStatus;
  registeredAt: string | null;
  lastError: string | null;
  hasSigningKey: boolean;
  source: RegistrationSource;
  publicUrl: string | null;
}

const state: InternalState = {
  endpointId: null,
  name: null,
  status: "NOT_REGISTERED",
  signingKeySecret: null,
  registeredAt: null,
  lastError: null,
  source: "none",
  publicUrl: null,
};

let inFlight: Promise<void> | null = null;

const ENDPOINT_NAME_PREFIX = "bay19-auto-";

function resolvePublicUrl(): { url: string | null; source: RegistrationSource } {
  const override = process.env.WEBHOOK_PUBLIC_URL?.trim();
  if (override) {
    return {
      url: `${override.replace(/\/+$/, "")}/collaborative-auth`,
      source: "manual",
    };
  }
  if (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_URL) {
    return {
      url: `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/collaborative-auth`,
      source: "auto",
    };
  }
  return { url: null, source: "none" };
}

function resolveEndpointName(): string {
  const sha = process.env.RENDER_GIT_COMMIT?.slice(0, 7);
  return `${ENDPOINT_NAME_PREFIX}${sha ?? Date.now()}`;
}

function mapEndpointStatus(input: string | undefined): RegistrationStatus {
  switch (input) {
    case "ACTIVE":
      return "ACTIVE";
    case "PENDING_VERIFICATION":
      return "PENDING_VERIFICATION";
    case "DEACTIVATED":
      return "DEACTIVATED";
    case "ACTIVATION_FAILED":
      return "ACTIVATION_FAILED";
    default:
      return "PENDING_VERIFICATION";
  }
}

// Remove every prior bay19-auto-* endpoint before registering a fresh one.
// Runs before addEndpoint, so the new endpoint does not exist yet — we must NOT
// skip same-named endpoints (re-deploying the same commit reuses the name), or
// stale ACTIVATION_FAILED endpoints accumulate and hit the 5-endpoint limit.
async function cleanupStaleEndpoints(): Promise<number> {
  let removed = 0;
  for await (const ep of highnote.collaborativeAuth.list()) {
    if (!ep.name?.startsWith(ENDPOINT_NAME_PREFIX)) continue;
    try {
      await highnote.collaborativeAuth.removeEndpoint({ endpointId: ep.id });
      removed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[collab-auth] Failed to remove stale endpoint ${ep.id} (${ep.name}): ${message}`,
      );
    }
  }
  return removed;
}

async function doRegister(): Promise<void> {
  const { url, source } = resolvePublicUrl();
  state.publicUrl = url;
  state.source = source;

  if (!url) {
    state.status = "NOT_REGISTERED";
    state.lastError = null;
    console.log(
      "[collab-auth] No public URL detected (RENDER_EXTERNAL_URL or WEBHOOK_PUBLIC_URL); skipping auto-register.",
    );
    return;
  }

  const name = resolveEndpointName();

  try {
    try {
      const removed = await cleanupStaleEndpoints();
      if (removed > 0) {
        console.log(
          `[collab-auth] Removed ${removed} stale ${ENDPOINT_NAME_PREFIX}* endpoint(s) before registering.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[collab-auth] Cleanup phase failed (continuing to register): ${message}`,
      );
    }

    const endpoint = await highnote.collaborativeAuth.addEndpoint({ name, uri: url });

    const secret = endpoint.signingKeys?.[0]?.secret ?? null;
    if (!secret) {
      throw new Error(
        "addCollaborativeAuthorizationEndpoint returned no signing key secret",
      );
    }

    state.endpointId = endpoint.id;
    state.name = endpoint.name ?? name;
    state.status = mapEndpointStatus(endpoint.status);
    state.signingKeySecret = secret;
    state.registeredAt = endpoint.createdAt ?? new Date().toISOString();
    state.lastError = null;

    try {
      const activated = await highnote.collaborativeAuth.activateEndpoint({
        endpointId: endpoint.id,
      });
      state.status = mapEndpointStatus(activated.status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[collab-auth] Activation call failed (endpoint registered but inactive): ${message}`,
      );
    }

    console.log(
      `[collab-auth] Registered endpoint ${endpoint.id} (${state.name}); status=${state.status}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = "REGISTRATION_FAILED";
    state.lastError = message;
    state.signingKeySecret = null;
    state.endpointId = null;
    state.name = null;
    state.registeredAt = null;
    console.error(`[collab-auth] Registration failed: ${message}`);
  }
}

const CUTOVER_POLL_ATTEMPTS = 30;
const CUTOVER_POLL_MS = 5000; // up to ~2.5 min waiting for Render to cut over
const ACTIVATION_RETRY_ATTEMPTS = 4;
const ACTIVATION_RETRY_MS = 4000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until Render has cut external traffic over to THIS instance. During a
 * deploy the public URL keeps routing to the OLD instance — which holds a
 * different signing key — until the new one passes its health check, so any
 * activation before cutover fails (Highnote's verification ping reaches the old
 * instance and gets a 401). We poll our own public `/health` and wait until it
 * echoes this process's boot id. Best-effort: on timeout we proceed anyway.
 */
async function waitForExternalCutover(baseUrl: string): Promise<void> {
  for (let i = 0; i < CUTOVER_POLL_ATTEMPTS; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { bootId?: string };
        if (body.bootId === BOOT_ID) {
          console.log(
            `[collab-auth] External cutover confirmed after ~${(i * CUTOVER_POLL_MS) / 1000}s.`,
          );
          return;
        }
      }
    } catch {
      // Public URL not reachable from here yet; keep waiting.
    }
    await delay(CUTOVER_POLL_MS);
  }
  console.warn(
    "[collab-auth] External cutover not confirmed within window; registering anyway.",
  );
}

/**
 * Register, retrying until the endpoint reports ACTIVE. We first wait for Render
 * to route external traffic to this instance (so the activation verification
 * ping actually reaches us), then run the full registration — the same path the
 * manual Re-register button takes. A few retries cover any residual flakiness.
 * Each attempt's cleanup removes the prior endpoint so they don't pile up.
 * Returns immediately when there's nothing to register (local, no public URL).
 */
async function doRegisterWithRetry(): Promise<void> {
  const { url } = resolvePublicUrl();
  if (!url) {
    await doRegister();
    return;
  }
  await waitForExternalCutover(url.replace(/\/collaborative-auth$/, ""));
  for (let attempt = 1; attempt <= ACTIVATION_RETRY_ATTEMPTS; attempt++) {
    await doRegister();
    if (state.status === "ACTIVE" || state.status === "NOT_REGISTERED") return;
    if (attempt < ACTIVATION_RETRY_ATTEMPTS) {
      console.warn(
        `[collab-auth] status=${state.status} after attempt ${attempt}/${ACTIVATION_RETRY_ATTEMPTS}; retrying in ${ACTIVATION_RETRY_MS}ms`,
      );
      await delay(ACTIVATION_RETRY_MS);
    }
  }
}

/**
 * Idempotent, single-flight registration. Concurrent callers await the same
 * promise. Errors are caught and recorded in state — does not throw.
 */
export function init(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doRegisterWithRetry().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Manual re-registration (the operator "Re-register" button). Runs a single
 * warm registration with NO cutover wait or retry loop — by the time an
 * operator clicks, the instance is already serving, so the request returns
 * promptly instead of blocking on the deploy-time cutover poll (which could
 * otherwise hang the HTTP request well past proxy/browser timeouts). The
 * cutover wait + retry belong only to startup (init()).
 */
export function register(): Promise<void> {
  return doRegister();
}

/** In-memory signing key for the receiver. `null` means signature verification is skipped. */
export function getSigningKey(): string | null {
  return state.signingKeySecret;
}

/**
 * The server-resolved public `/collaborative-auth` URL, or `null` if none is
 * configured. Derived only from server env — never from request headers.
 */
export function getPublicEndpointUrl(): string | null {
  return resolvePublicUrl().url;
}

/** Public-safe view of cached registration state. Never includes the signing key. */
export function getPublicStatus(): PublicStatus {
  return {
    endpointId: state.endpointId,
    name: state.name,
    status: state.status,
    registeredAt: state.registeredAt,
    lastError: state.lastError,
    hasSigningKey: state.signingKeySecret !== null,
    source: state.source,
    publicUrl: state.publicUrl,
  };
}

// Throttle window for the live status refresh. The status route is polled by
// every operator's SPA, and each refresh costs one Highnote API call against
// the same rate budget collaborative-auth needs to answer within its 2s
// window. Coalescing polls inside this window keeps badge freshness without
// letting a tight poll loop amplify into upstream churn.
const STATUS_REFRESH_TTL_MS = 5_000;
let lastLiveRefreshAt = 0;

/**
 * Public status with a best-effort live refresh from Highnote, so the UI shows
 * the true current state (ACTIVE / PENDING_VERIFICATION / ACTIVATION_FAILED /
 * DEACTIVATED) rather than the value cached at registration time. The CA SDK
 * has no get-by-id, so we scan `list()` for our endpoint. On any lookup failure
 * we fall back to the cached state. The upstream call is throttled to at most
 * one per STATUS_REFRESH_TTL_MS; within that window the cached snapshot serves.
 */
export async function getStatus(): Promise<PublicStatus> {
  if (state.endpointId && Date.now() - lastLiveRefreshAt >= STATUS_REFRESH_TTL_MS) {
    lastLiveRefreshAt = Date.now();
    try {
      for await (const ep of highnote.collaborativeAuth.list()) {
        if (ep.id === state.endpointId) {
          state.status = mapEndpointStatus(ep.status);
          if (ep.name) state.name = ep.name;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[collab-auth] Live status refresh failed: ${message}`);
    }
  }
  return getPublicStatus();
}
