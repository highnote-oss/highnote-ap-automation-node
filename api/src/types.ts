/** Zod schemas for request validation and OpenAPI spec generation. */

import { z } from "zod";

// --- Auth ---

export const SignupBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

export type SignupBody = z.infer<typeof SignupBodySchema>;

export const LoginBodySchema = SignupBodySchema;

export type LoginBody = z.infer<typeof LoginBodySchema>;

// --- Shared schemas ---

export const IdParamsSchema = z.object({ id: z.string().min(1) });

export const SlugParamsSchema = z.object({ slug: z.string().min(8) });

// --- Invoices ---

export const CreateInvoiceBodySchema = z.object({
  vendorName: z.string().min(1).max(200),
  vendorEmail: z.string().email(),
  invoiceNumber: z.string().min(1).max(100),
  amountCents: z.number().int().positive(),
  currencyCode: z.string().length(3).default("USD"),
  dueDate: z.string().optional(),
  expectedMcc: z.string().regex(/^\d{4}$/).optional(),
});

export type CreateInvoiceBody = z.infer<typeof CreateInvoiceBodySchema>;

export const ApproveInvoiceBodySchema = z.object({
  sourceFundingAccountId: z.string().min(1),
});

export type ApproveInvoiceBody = z.infer<typeof ApproveInvoiceBodySchema>;

export type InvoiceStatus =
  | "DRAFT"
  | "APPROVED"
  | "CARD_ISSUED"
  | "AUTHORIZED"
  | "CLEARED"
  | "RECONCILED"
  | "CANCELLED";
