#!/usr/bin/env bash
#
# Applies the Highnote-example security posture to a freshly-created repo:
# branch protection, required status checks, secret scanning, push protection,
# validity checks, CodeQL default setup, private vulnerability reporting, and
# the tag protection ruleset.
#
# Idempotent — safe to re-run. Use after creating a repo from this template,
# and again after flipping the repo from internal to public (the visibility
# change silently disables some security toggles).
#
# Usage:
#   bash scripts/bootstrap-repo.sh <owner/repo>
#
# Example:
#   bash scripts/bootstrap-repo.sh highnote-oss/highnote-fleet-node
#
# Prerequisites:
#   - gh CLI authenticated against an account with admin on the target repo
#   - The target repo already exists on GitHub
#   - For CodeQL + push protection on private/internal repos: GitHub Advanced
#     Security enabled at the org level (not the case for highnote-oss today).
#     On public repos these features are free. The script tolerates failures
#     on the GHAS-gated calls so it still works on internal repos.

set -euo pipefail

# ----- args ------------------------------------------------------------------

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "usage: bash scripts/bootstrap-repo.sh <owner/repo>" >&2
  exit 2
fi

# The PR-bypass user (a solo maintainer allowed to push to main without a PR).
# Defaults to whoever runs this script; override with BYPASS_USER=<login>, or
# set BYPASS_USER= (empty) for strict protection with no bypass. Extend
# bypass_pull_request_allowances.teams for team-level bypass.
BYPASS_USER="${BYPASS_USER-$(gh api user --jq .login 2>/dev/null || true)}"
if [[ -n "$BYPASS_USER" ]]; then
  BYPASS_USERS_JSON="[\"$BYPASS_USER\"]"
else
  BYPASS_USERS_JSON="[]"
fi

# Required status check names — must EXACTLY match the job names from
# .github/workflows/ci.yml. Em-dashes matter.
REQUIRED_CHECKS='["API — typecheck, build & test", "Web — typecheck & build"]'

echo "==> Bootstrap repo $REPO (bypass user: ${BYPASS_USER:-<none>})"

# ----- branch protection on main --------------------------------------------

echo "--> branch protection on main"
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<JSON --jq '{lock_branch: .lock_branch.enabled, checks: .required_status_checks.contexts}'
{
  "required_status_checks": {
    "strict": true,
    "contexts": $REQUIRED_CHECKS
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "bypass_pull_request_allowances": {
      "users": $BYPASS_USERS_JSON,
      "teams": [],
      "apps": []
    }
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false,
  "required_signatures": true
}
JSON

# ----- security features ----------------------------------------------------

echo "--> secret scanning + push protection + validity checks"
gh api -X PATCH "repos/$REPO" \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_validity_checks][status]=enabled' \
  --jq '.security_and_analysis | {secret_scanning: .secret_scanning.status, push_protection: .secret_scanning_push_protection.status, validity_checks: .secret_scanning_validity_checks.status}' \
  || echo "    (some toggles may need GHAS or public visibility — see script header)"

echo "--> private vulnerability reporting"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" 2>/dev/null \
  && echo "    enabled" \
  || echo "    (already enabled or unavailable)"

echo "--> CodeQL default setup"
gh api -X PATCH "repos/$REPO/code-scanning/default-setup" \
  -f state=configured -f query_suite=default 2>&1 | head -2 \
  || echo "    (needs GHAS on private/internal, free on public — re-run after public flip)"

# ----- tag protection ruleset (idempotent: skips if same-named exists) ------
#
# Blocks tag creation, deletion, and force-moves (empty bypass list => applies
# to everyone, including github-actions[bot]). That's fine for example apps,
# which don't publish artifacts or push release tags.
#
# WARNING: if a repo bootstrapped from this template WILL publish release tags
# via CI (like highnote-oss/nodejs-sdk), remove the `creation` rule below first
# (or add a bypass actor) — otherwise the release workflow's
# `git push origin vX.Y.Z` is rejected. Since publish typically runs before
# tagging, it fails *after* the package is already on npm, leaving npm and git
# out of sync. Note: the default GITHUB_TOKEN cannot be a ruleset bypass actor,
# so a bypass-based fix needs a PAT/App identity, not the built-in token.
# Keep `deletion` + `non_fast_forward` either way so published tags stay immutable.

echo "--> tag protection ruleset"
EXISTING=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "release-tags") | .id' 2>/dev/null || echo "")
if [[ -n "$EXISTING" ]]; then
  echo "    release-tags ruleset already exists (id $EXISTING); skipping"
else
  gh api -X POST "repos/$REPO/rulesets" --input - --jq '{name, enforcement}' <<'JSON'
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {"ref_name": {"include": ["~ALL"], "exclude": []}},
  "rules": [{"type": "creation"}, {"type": "deletion"}, {"type": "non_fast_forward"}]
}
JSON
fi

# ----- summary --------------------------------------------------------------

echo
echo "==> Done. Final state:"
gh api "repos/$REPO/branches/main/protection" --jq '{lock_branch: .lock_branch.enabled, required_signatures: .required_signatures.enabled, required_checks: .required_status_checks.contexts}'
gh api "repos/$REPO" --jq '.security_and_analysis | {secret_scanning: .secret_scanning.status, push_protection: .secret_scanning_push_protection.status, validity_checks: .secret_scanning_validity_checks.status}'
gh api "repos/$REPO/code-scanning/default-setup" --jq '{code_scanning: .state}' 2>/dev/null || true
gh api "repos/$REPO/rulesets" --jq '.[] | "ruleset: \(.name) (\(.target), \(.enforcement))"'
