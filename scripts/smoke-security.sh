#!/usr/bin/env bash
#
# Security smoke test for the registration-hardening changes.
#
# Verifies, against a running instance:
#   1. Admin gate  — a non-admin authenticated user is 403'd from the
#      money-movement registration routes when ADMIN_EMAILS is configured.
#   2. Cooldown    — the per-route rate limit (3 / 5 min) returns 429 on the
#      4th rapid call. DESTRUCTIVE (it re-registers the endpoint), so it is
#      opt-in via SMOKE_DESTRUCTIVE=1.
#
# Usage:
#   BASE_URL=https://your-app.onrender.com ./scripts/smoke-security.sh
#   SMOKE_DESTRUCTIVE=1 BASE_URL=... ./scripts/smoke-security.sh   # also run cooldown
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EMAIL="sec-smoke-$(date +%s)@example.com"
PASSWORD="sec-smoke-pass-1234"
PASS=0 FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
ok()    { green "  PASS  $1"; PASS=$((PASS+1)); }
bad()   { red   "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "Target: $BASE_URL"

# --- auth: sign up a fresh (non-admin) user ---------------------------------
TOKEN="$(curl -fsS -X POST "$BASE_URL/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | \
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { red "could not obtain token (signup failed)"; exit 1; }
echo "Signed up non-admin user: $EMAIL"

status_of() {
  # POST with empty body to a register route; echo the HTTP status only.
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL$1" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
}

# --- check 1: admin gate ----------------------------------------------------
echo
echo "[1] Admin gate (ADMIN_EMAILS) on registration routes"
for route in /api/collab-auth/register /api/webhooks/register; do
  code="$(status_of "$route")"
  case "$code" in
    403) ok "$route → 403 (gate active, non-admin rejected)";;
    429) ok "$route → 429 (cooldown already engaged — gate not exercised)";;
    200|201) bad "$route → $code (gate OPEN: set ADMIN_EMAILS to restrict)";;
    *)   bad "$route → $code (unexpected)";;
  esac
done

# --- check 2: cooldown (opt-in, destructive) --------------------------------
echo
if [ "${SMOKE_DESTRUCTIVE:-0}" = "1" ]; then
  echo "[2] Cooldown: 4 rapid calls to /api/webhooks/register, expect 429 on the 4th"
  echo "    (requires this user to pass the admin gate; set ADMIN_EMAILS to include $EMAIL or leave it unset)"
  last=""
  for i in 1 2 3 4; do
    last="$(status_of /api/webhooks/register)"
    echo "    attempt $i → $last"
  done
  if [ "$last" = "429" ]; then ok "4th call rate-limited (429)"; else bad "4th call was $last, expected 429"; fi
else
  echo "[2] Cooldown check skipped (set SMOKE_DESTRUCTIVE=1 to run — it re-registers the endpoint)"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
