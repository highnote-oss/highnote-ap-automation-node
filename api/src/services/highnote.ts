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
