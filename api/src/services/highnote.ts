import { Highnote } from "@highnote-oss/nodejs-sdk";
import type { HighnoteEnvironment } from "@highnote-oss/nodejs-sdk";

const apiKey = process.env.HIGHNOTE_API_KEY;
if (!apiKey) {
  throw new Error("HIGHNOTE_API_KEY is required (.env or environment).");
}

export const environment = (process.env.HIGHNOTE_ENVIRONMENT ?? "test") as HighnoteEnvironment;
export const cardProductId = process.env.HIGHNOTE_CARD_PRODUCT_ID ?? "";
export const applicationId = process.env.HIGHNOTE_APPLICATION_ID ?? "";

if (!cardProductId) throw new Error("HIGHNOTE_CARD_PRODUCT_ID is required.");
if (!applicationId) throw new Error("HIGHNOTE_APPLICATION_ID is required.");

export const highnote = new Highnote({ apiKey, environment });

let cachedAccountHolderId: string | null = null;

/**
 * Look up the application once at first need and cache the underlying
 * account holder ID. The demo supports both paths:
 *   - subscriber product offering applications (snapshot is
 *     BusinessProductApplicantSnapshot)
 *   - business or person account holder applications (snapshot is
 *     USBusinessAccountHolderSnapshot or USPersonAccountHolderSnapshot)
 *
 * The SDK's findApplication fragment selects `accountHolderCurrent.id` on
 * all three variants, so the same code path covers each.
 */
export async function getAccountHolderId(): Promise<string> {
  if (cachedAccountHolderId) return cachedAccountHolderId;

  const app = await highnote.applications.get(applicationId);
  const snapshot = app.accountHolderSnapshot;
  if (!snapshot) {
    throw new Error(
      `Application ${applicationId} has no accountHolderSnapshot — cannot derive account holder ID. Check the application is APPROVED.`,
    );
  }

  const id = (snapshot as { accountHolderCurrent?: { id?: string } }).accountHolderCurrent?.id;

  if (!id) {
    throw new Error(
      `Could not extract account holder ID from snapshot of ${applicationId} (typename=${snapshot.__typename}). The application may not be APPROVED yet.`,
    );
  }

  cachedAccountHolderId = id;
  return id;
}
