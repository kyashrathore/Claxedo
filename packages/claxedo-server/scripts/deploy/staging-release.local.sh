#!/usr/bin/env bash
# Collect the staging release inputs from this machine and hand them to
# scripts/deploy/staging-release.ts, for when the GitHub `staging` environment
# is not configured yet. CI runs the same TypeScript with the same variable
# names; only the source of the values differs.
#
# Defaults to --dry-run, which reads the ledger and prints the derived inputs
# without changing anything. Releasing for real is an explicit opt-in:
#
#   packages/claxedo-server/scripts/deploy/staging-release.local.sh
#   packages/claxedo-server/scripts/deploy/staging-release.local.sh --release
set -euo pipefail

SERVER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "$SERVER_ROOT/../.." && pwd)"

MODE=--dry-run
for argument in "$@"; do
  [ "$argument" = "--release" ] && MODE=""
done

# CLOUDFLARE_API_TOKEN lives in packages/claxedo-server/.env*; this is the one
# reader for those files, and anything already exported wins.
# shellcheck source=/dev/null
. "$REPO_ROOT/script/load-server-env.sh"
claxedo_load_server_env "$REPO_ROOT"

# The deployment's secret bundle is one keychain generic password holding a JSON
# object keyed by the names below. `-w` prints the value, so it is piped
# straight into the shell's environment and never echoed — do not run this under
# `set -x`.
KEYCHAIN_SERVICE="${CLAXEDO_STAGING_KEYCHAIN_SERVICE:-claxedo-cf-acceptance-260830-232009-3851}"
KEYCHAIN_ACCOUNT="${CLAXEDO_STAGING_KEYCHAIN_ACCOUNT:-deployment}"
RELEASE_SECRETS=(BETTER_AUTH_SECRET CLAXEDO_AUTH_INTROSPECTION_SECRET)

if ! security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
  echo "keychain item $KEYCHAIN_SERVICE/$KEYCHAIN_ACCOUNT not found; it must hold a JSON object with ${RELEASE_SECRETS[*]}" >&2
  exit 1
fi

eval "$(
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w |
    NAMES="${RELEASE_SECRETS[*]}" node "$SERVER_ROOT/scripts/deploy/keychain-bundle-exports.mjs"
)"

export CLAXEDO_ADAPTER_PROFILE=better-auth-d1
export CLAXEDO_PRODUCT_POSTURE=user-deployed
export CLAXEDO_SANDBOX_POSTURE=full-hosted
export CLAXEDO_SANDBOX_DRIVER=cloudflare
export CLAXEDO_AUTH_METHODS=github
export CLAXEDO_ENVIRONMENT_ID=staging-acc-260830-232009-3851
export CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID=org-acc-260830-232009-3851
export CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME='Claxedo Acceptance Staging'

export CLAXEDO_STAGING_DEPLOYMENT_ID=acc-stg-260830-232009-3851
export CLAXEDO_STAGING_API_ORIGIN=https://cf-acc-stg-260830-232009-3851.claxedo.dev
export CLAXEDO_STAGING_APP_ORIGIN=https://app-acc-stg-260830-232009-3851.claxedo.dev
export CLAXEDO_STAGING_WORKSPACE_RELAY_URL=https://claxedo-workspace-relay-acc-stg-260830-3851.kanusdlp.workers.dev
export CLAXEDO_STAGING_AUTH_D1_DATABASE_ID=d300f9ca-d3fe-47ce-ae7d-163ceee62e69
export CLAXEDO_STAGING_AUTH_D1_DATABASE_NAME=claxedo-acc-auth-stg-260830-232009-3851
export CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_ID=2456d9cc-885a-4916-ac78-bb4f60379c99
export CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME=claxedo-acc-control-stg-260830-232009-3851
export CLAXEDO_STAGING_SANDBOX_WORKER_URL=https://sandbox.claxedo.com

# release-better-auth-d1.ts refuses a release whose two environments share a
# deployment id, origin, database or limiter namespace, so the production side
# is an input even on a staging run. These name the pre-provisioned production
# resources; no production Worker exists yet.
export CLAXEDO_PRODUCTION_DEPLOYMENT_ID=acc-prod-260830-232009-3851
export CLAXEDO_PRODUCTION_API_ORIGIN=https://cf-acc-prod-260830-232009-3851.claxedo.dev
export CLAXEDO_PRODUCTION_APP_ORIGIN=https://app-acc-prod-260830-232009-3851.claxedo.dev
export CLAXEDO_PRODUCTION_WORKSPACE_RELAY_URL=https://claxedo-workspace-relay-acc-prod-260830-3851.kanusdlp.workers.dev
export CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_ID=86b365bf-40bc-4a12-a5f9-cc09adafa2db
export CLAXEDO_PRODUCTION_AUTH_D1_DATABASE_NAME=claxedo-acc-auth-prod-260830-232009-3851
export CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_ID=79ce035f-c552-419b-be95-1fb93396275a
export CLAXEDO_PRODUCTION_CONTROL_PLANE_D1_DATABASE_NAME=claxedo-acc-control-prod-260830-232009-3851

: "${GITHUB_CLIENT_ID:=Ov23lidDsgSi8fNVhErm}"
export GITHUB_CLIENT_ID

for name in CLOUDFLARE_API_TOKEN "${RELEASE_SECRETS[@]}"; do
  [ -n "${!name:-}" ] || { echo "$name is not set" >&2; exit 1; }
done

cd "$SERVER_ROOT"
# shellcheck disable=SC2086
exec bun scripts/deploy/staging-release.ts --staging $MODE
