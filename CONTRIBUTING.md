# Contributing

This repository is a **read-only public example** maintained by Highnote.
We do not accept external pull requests — they are auto-closed by a
workflow in `.github/workflows/close-external-prs.yml`.

- **Found a problem with this example?** Contact your Highnote account
  team or support channel.
- **Found a security issue?** Please report it via GitHub's
  [private vulnerability reporting form](https://github.com/highnote-oss/highnote-ap-automation-node/security/advisories/new) —
  see [`SECURITY.md`](SECURITY.md).

The rest of this document is for Highnote maintainers working on the
example.

## Setup

```bash
git clone https://github.com/highnote-oss/highnote-ap-automation-node.git
cd highnote-ap-automation-node
cp .env.template api/.env       # Fill in HIGHNOTE_API_KEY, JWT_SECRET, etc.

(cd api && npm install)
(cd web && npm install)
```

## Development

```bash
# API
(cd api && npm run dev)        # Hot-reload Fastify on :3000
(cd api && npm run build)      # Compile TypeScript to dist/
(cd api && npm test)           # Run vitest

# Web
(cd web && npm run dev)        # Vite dev server on :5173
(cd web && npm run build)      # Build SPA to dist/
```

The API self-creates its SQLite schema on boot (`ensureTables()`), so
there is no separate migration step for local development. The database
file defaults to `./data/app.db` (override with `SQLITE_PATH`).

## Container / deploy

```bash
docker compose up --build      # Build + run the multi-stage image locally
```

`render.yaml` declares a Render Web Service that builds the same
`Dockerfile`. Secrets (`HIGHNOTE_API_KEY`, `JWT_SECRET`, etc.) are set in
the Render dashboard, not committed.

## CI

GitHub Actions runs on every PR and push to main:

- **API — typecheck, build & test** — `tsc --noEmit`, `npm run build`,
  `npm test` in `api/`
- **Web — typecheck & build** — `npm run build` in `web/`
- **CodeQL** — default-setup code scanning (enabled by `bootstrap-repo.sh`)
- **Dependency review** — fires on PRs that touch lockfiles
- **Auto-close external PR** — closes PRs from non-maintainers (see
  `close-external-prs.yml`)

## Releasing

Examples don't publish to npm; the "release" is the deployed app. There
is no release workflow — every merge to main is the release (Render
auto-deploys, if connected).
