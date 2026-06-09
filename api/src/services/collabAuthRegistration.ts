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

import { highnote } from "./highnote.js";

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

async function cleanupStaleEndpoints(currentName: string): Promise<number> {
  let removed = 0;
  for await (const ep of highnote.collaborativeAuth.list()) {
    if (!ep.name?.startsWith(ENDPOINT_NAME_PREFIX)) continue;
    if (ep.name === currentName) continue;
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
      const removed = await cleanupStaleEndpoints(name);
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

/**
 * Idempotent, single-flight registration. Concurrent callers await the same
 * promise. Errors are caught and recorded in state — does not throw.
 */
export function init(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doRegister().finally(() => {
    inFlight = null;
  });
  return inFlight;
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

/** Public-safe view of registration state. Never includes the signing key. */
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
