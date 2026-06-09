# Security Policy

## Reporting a Vulnerability

If you discover a security issue with this example app, please report it
privately using GitHub's **[Report a vulnerability](https://github.com/highnote-oss/highnote-ap-automation-node/security/advisories/new)**
form (also reachable via the **Security** tab → **Report a vulnerability**).

Please do **not** disclose the issue publicly until we have had a chance to
investigate and respond.

For security issues with the `@highnote-oss/nodejs-sdk` package itself,
please report them on **that repo's** security tab, not here:

- [`highnote-oss/nodejs-sdk`](https://github.com/highnote-oss/nodejs-sdk/security/advisories/new)

We aim to acknowledge reports as quickly as we can, but cannot commit to a
specific response time — this example app is maintained on a best-effort
basis.

## Status: reference demo, not production-hardened

This repository is an **example / reference application** demonstrating an
AP (accounts payable) invoice workflow on the Highnote platform. It is
intentionally not hardened for serving real users. The deliberate gaps
below enumerate what you would have to add yourself before adopting any
part of it beyond illustration.

### Deliberate gaps

These are intentional shortcuts appropriate for a demo. Each item names the
concern and the change you would make if you adopted the app for real users.

- **Authentication & sessions** — login issues a JWT signed with a single
  shared `JWT_SECRET` (`api/src/middleware/auth.ts`, `api/src/routes/auth.ts`).
  There is no token refresh/rotation, revocation list, or session store; the
  template default secret (`change-me-in-prod`) must be replaced. Passwords
  are hashed with bcrypt, but there is no account lockout, MFA, or password
  policy.
- **Persistence** — state lives in a single local SQLite file
  (`better-sqlite3`, default `./data/app.db`). The schema is created at boot
  by `ensureTables()` rather than versioned migrations, and the file is
  ephemeral on a stateless host (e.g. Render) unless a persistent disk is
  attached. It is single-writer and not suitable for multi-instance or
  high-concurrency use.
- **Multi-tenancy** — a single shared database with demo accounts; there is
  no tenant isolation, per-tenant key scoping, or row-level access control.
- **Secret management** — secrets are read from environment / a local `.env`
  file via `dotenv`. There is no integration with a secrets manager, and no
  rotation story for `HIGHNOTE_API_KEY` or `JWT_SECRET`.
- **Transport & headers** — `@fastify/helmet` is enabled, but the CSP may be
  run in report-only mode (`CSP_REPORT_ONLY`) for demo convenience, and CORS
  is permissive in non-production (`CORS_ORIGIN`). Lock both down before any
  real deployment.
- **Rate limiting & abuse** — `@fastify/rate-limit` is configured for demo
  ergonomics, not to withstand abuse; tune limits and add upstream protection
  before exposing the app publicly.
- **Webhooks & collaborative auth** — the app auto-registers webhook and
  collaborative-auth endpoints at startup against `WEBHOOK_PUBLIC_URL`.
  Verify webhook signatures, scope the registrations, and review the
  pay-by-link / client-token surfaces before trusting them with real money
  movement.
