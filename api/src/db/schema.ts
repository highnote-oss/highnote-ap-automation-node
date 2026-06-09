import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),

  vendorName: text("vendor_name").notNull(),
  vendorEmail: text("vendor_email").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  dueDate: text("due_date"),
  expectedMcc: text("expected_mcc"),
  pdfPath: text("pdf_path"),

  status: text("status").notNull().default("DRAFT"),

  sourceFundingAccountId: text("source_funding_account_id"),
  cardId: text("card_id"),
  cardFinancialAccountId: text("card_financial_account_id"),

  payBySlug: text("pay_by_slug").unique(),
  payByClientToken: text("pay_by_client_token"),
  payBySlugExpiresAt: text("pay_by_slug_expires_at"),

  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const collabAuthDecisions = sqliteTable("collab_auth_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: text("invoice_id"),
  paymentCardId: text("payment_card_id").notNull(),
  requestId: text("request_id").notNull(),
  requestedAmountCents: integer("requested_amount_cents").notNull(),
  merchantCategoryCode: text("merchant_category_code"),
  decision: text("decision").notNull(),
  reason: text("reason"),
  rawPayload: text("raw_payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`(datetime('now'))`),
});

export const webhookEvents = sqliteTable("webhook_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").unique(),
  eventType: text("event_type").notNull(),
  invoiceId: text("invoice_id"),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`(datetime('now'))`),
});
