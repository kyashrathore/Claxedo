#!/usr/bin/env bash
# Boot the CURRENTLY SHIPPED self-hosted entry, write durable state through its
# real HTTP routes, then boot the NEW entry against that exact data root and
# prove identity, authorization, configuration, and credential state carried
# across the version boundary — and across one further new-entry restart.
#
# Why this exists separately from self-hosted-restart.sh: that script restarts
# the SAME build twice. Same-version persistence proves the bytes reach disk; it
# cannot prove that a build which moved the entry, split four packages out, and
# added a boot gate still READS what the shipped build WROTE. Only two different
# builds over one data directory can show that, and the two builds must be two
# process lifetimes for the same reason the restart script gives: an in-process
# "upgrade" shares the module registry and the open SQLite handle, so it proves
# the cache still has the row.
#
# The old entry (src/deployments/local/main.ts) no longer exists in the working
# tree — Unit 7 moved it to src/deployments/self-hosted-node/index.ts. It is
# obtained from git history and materialized in a throwaway worktree. See
# `materialize_old_tree` for how that worktree gets a usable node_modules and
# why the result is still a faithful old build.
#
# Exit codes: 0 = the upgrade was verified. 1 = it was run and something did not
# carry across. 3 = SKIP, the old build could not be materialized here; the
# message names what is left unverified. 3 is deliberately not 0, because a
# skipped upgrade check must never read as a passing one.
set -euo pipefail

PORT="${PORT:-3196}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # packages/claxedo-server
repo="$(cd "$here/../.." && pwd)"

# The shipped entry is the one on the branch this work merges into, so the only
# variable between the two boots is this branch's own changes. Override OLD_REF
# to pin a different "before" (any commit that still has deployments/local).
OLD_REF="${OLD_REF:-$(git -C "$repo" merge-base dev HEAD 2>/dev/null || true)}"
OLD_ENTRY="packages/claxedo-server/src/deployments/local/main.ts"
NEW_ENTRY="src/deployments/self-hosted-node/index.ts"

WORK="$(mktemp -d)"
DATA_DIR="$WORK/data"
OLD_TREE="$WORK/oldtree"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
  # --force twice: once for the worktree's dirty state (built dist/, linked
  # node_modules), once because the checkout is detached.
  git -C "$repo" worktree remove --force --force "$OLD_TREE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

skip() { echo; echo "SKIP: $*" >&2; exit 3; }
fail() { echo; echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

# ---------------------------------------------------------------- old tree ---

# The old commit's tree carries source but no node_modules and no built dist/.
# Both are reconstructed rather than reinstalled: `bun install` in a fresh
# worktree re-runs the workspace postinstall builds, which cost minutes and
# gigabytes for a fixture that needs one server to boot.
materialize_old_tree() {
  git -C "$repo" cat-file -e "$OLD_REF:$OLD_ENTRY" 2>/dev/null \
    || skip "no shipped self-hosted entry at OLD_REF=$OLD_REF ($OLD_ENTRY is absent there);" \
            "cross-version upgrade of identity, authorization, config, and credential state is UNVERIFIED"
  command -v bun >/dev/null 2>&1 \
    || skip "bun is required to build the old tree's workspace dists; cross-version upgrade is UNVERIFIED"

  git -C "$repo" worktree add --detach "$OLD_TREE" "$OLD_REF" >/dev/null 2>&1 \
    || skip "could not create a git worktree at $OLD_REF; cross-version upgrade is UNVERIFIED"

  # Third-party packages are shared with the current tree's bun store instead of
  # reinstalled. That is sound here and checked, not assumed: the guard below
  # refuses to run if the two commits disagree on any third-party version, which
  # is what would make the shared store misrepresent the old build. Workspace
  # packages are NOT shared — every @claxedo/* and workspace symlink is bent
  # back into OLD_TREE, so the old entry runs old siblings.
  NM_DIRS="$(cd "$repo" && find . -maxdepth 4 -name node_modules -type d -not -path '*/node_modules/*' | sed 's|^\./||')" \
    node "$WORK/link-node-modules.mjs" "$repo" "$OLD_TREE" \
    || skip "could not mirror node_modules into the old worktree; cross-version upgrade is UNVERIFIED"

  # Dependency order. These are exactly the workspace packages whose built
  # dist/ the self-hosted server's module graph imports; the server resolves
  # them through package exports, so a missing dist is a boot-time
  # ERR_MODULE_NOT_FOUND rather than a type error. workspace-runtime is last
  # because its declaration emit reads the others' dist/*.d.ts.
  for pkg in agent-extensions agent-event-runtime agent-sdk-runtime workgraph \
             workspace-relay-protocol workspace-relay sandbox-manager wakes \
             claxedo-connections claxedo-channels claxedo-mcp workspace-runtime; do
    (cd "$OLD_TREE/packages/$pkg" && bun run build) >/dev/null 2>&1 \
      || skip "the old tree's $pkg build failed; the shipped entry cannot be booted here" \
              "and the cross-version upgrade is UNVERIFIED"
  done
}

cat > "$WORK/link-node-modules.mjs" <<'MJS'
import { readdirSync, lstatSync, mkdirSync, symlinkSync, realpathSync, existsSync } from "node:fs"
import { join, resolve, relative, isAbsolute } from "node:path"

const [, , CUR, OLD] = process.argv
const curPkgs = resolve(CUR, "packages")

const isWorkspacePackage = (p) => {
  const r = relative(curPkgs, p)
  return r && !r.startsWith("..") && !isAbsolute(r)
}

// Scope directories (@claxedo, @types) and .bin hold the links, so they are
// recreated rather than linked wholesale — linking the scope directory itself
// would drag the current tree's workspace packages in with it.
function mirror(curDir, oldDir) {
  mkdirSync(oldDir, { recursive: true })
  for (const name of readdirSync(curDir)) {
    const src = join(curDir, name)
    const dst = join(oldDir, name)
    if (existsSync(dst)) continue
    if (lstatSync(src).isDirectory() && (name.startsWith("@") || name === ".bin")) {
      mirror(src, dst)
      continue
    }
    let target
    try { target = realpathSync(src) } catch { continue }
    if (isWorkspacePackage(target)) {
      const oldTarget = join(OLD, "packages", relative(curPkgs, target))
      // A package that did not exist at the old commit gets no link at all, so
      // the old build fails loudly if it somehow reaches for one.
      if (existsSync(oldTarget)) symlinkSync(oldTarget, dst)
    } else {
      symlinkSync(target, dst)
    }
  }
}

for (const dir of process.env.NM_DIRS.split("\n").filter(Boolean)) {
  const cur = join(CUR, dir)
  const oldPkg = resolve(join(OLD, dir, ".."))
  if (!existsSync(cur) || !existsSync(oldPkg)) continue
  mirror(cur, join(OLD, dir))
}
MJS

# ------------------------------------------------------------------ runtime ---

# CLAXEDO_EMBEDDED_AUTH=1 is what puts real users and sessions in the data root:
# without it the box runs unsigned-local and there is no identity to carry
# across. CLAXEDO_DISABLE_OPENCODE_COMPAT=1 keeps boot to a few seconds.
healthy() { curl -fsS "http://127.0.0.1:$PORT/api/claxedo/health" >/dev/null 2>&1; }

boot() {
  local dir="$1" entry="$2" label="$3"
  # The whole fixture is "which build answered", so a health check that could be
  # answered by a server this function did not start is worthless. Refuse to
  # start on an occupied port rather than adopt whatever is listening.
  ! healthy || fail "something is already serving port $PORT; refusing to boot $label against it (set PORT=)"
  # `exec` matters: without it SERVER_PID is the subshell, and killing the
  # subshell leaves node holding the port — the next boot would fail to bind
  # while the health check kept passing against the PREVIOUS build.
  ( cd "$dir/packages/claxedo-server" \
    && CLAXEDO_DATA_DIR="$DATA_DIR" CLAXEDO_SERVER_PORT="$PORT" \
       CLAXEDO_EMBEDDED_AUTH=1 CLAXEDO_DISABLE_OPENCODE_COMPAT=1 \
       exec node --conditions=development \
         --import ../workspace-runtime/src/text-imports.mjs \
         --import tsx \
         "$entry" > "$WORK/boot-$label.log" 2>&1 ) &
  SERVER_PID=$!
  for _ in $(seq 1 90); do
    healthy && { echo "booted: $label"; return 0; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  echo "--- boot-$label.log ---" >&2; tail -30 "$WORK/boot-$label.log" >&2
  fail "the $label entry did not become healthy"
}

stop() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  # Proving the port went quiet is what makes the NEXT boot's answers
  # attributable to the next build.
  for _ in $(seq 1 30); do healthy || return 0; sleep 1; done
  fail "the previous server still answers on port $PORT; the next boot would be measured against it"
}

api()  { curl -sS "http://127.0.0.1:$PORT$1" "${@:2}"; }
code() { curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$1" "${@:2}"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],JSON.parse(s));console.log(v===undefined?"":v)}catch{console.log("")}})' "$1"; }

# Creates an embedded-auth user and echoes its bearer. The token arrives as a
# response HEADER, not in the body: better-auth's bearer() plugin issues it as
# set-auth-token, and only that full value (session id plus signature) is
# accepted back as `Authorization: Bearer`. The body is kept so a refusal
# (duplicate email, CSRF origin, rate limit) is reported instead of surfacing as
# an empty variable three assertions later.
signup() {
  local email="$1" name="$2" slug headers body token
  slug="$(printf '%s' "$email" | tr -c 'a-zA-Z0-9' '-')"
  headers="$WORK/signup-$slug.h"; body="$WORK/signup-$slug.json"
  api /api/auth/sign-up/email -D "$headers" -o "$body" -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"UpgradeProbe!2345\",\"name\":\"$name\"}"
  token="$(grep -i '^set-auth-token:' "$headers" | tr -d '\r' | sed 's/^[^:]*: *//' || true)"
  [ -n "$token" ] || fail "sign-up for $email returned no bearer session token: $(head -c 300 "$body")"
  printf '%s' "$token"
}

expect() {
  local what="$1" want="$2" got="$3"
  [ "$got" = "$want" ] || fail "$what: expected '$want', got '$got'"
  echo "  ok  $what = $got"
}
expect_contains() {
  local what="$1" needle="$2" hay="$3"
  case "$hay" in *"$needle"*) echo "  ok  $what contains $needle" ;;
                 *) fail "$what: '$needle' not found in: $(printf '%s' "$hay" | head -c 300)" ;; esac
}

# --------------------------------------------------------------------- run ---

[ -n "$OLD_REF" ] || skip "could not resolve OLD_REF (no merge-base with dev); cross-version upgrade is UNVERIFIED"

step "third-party dependency drift between $OLD_REF and HEAD"
# The shared bun store is only faithful while the two commits pin the same
# third-party versions. Workspace entries are expected to differ — this branch
# adds packages — so only non-workspace lockfile lines are compared.
drift="$(git -C "$repo" diff "$OLD_REF..HEAD" -- bun.lock \
  | grep -E '^[+-]' | grep -v '^[+-][+-]' \
  | grep -E '^\-' | grep -vE 'claxedo|workgraph|workspace-runtime|workspace-relay|agent-|opencode|wakes|sandbox-manager' || true)"
[ -z "$drift" ] || skip "third-party dependencies changed between $OLD_REF and HEAD, so the old tree cannot share this tree's" \
                        "package store; re-run after a real install in the old worktree. Cross-version upgrade is UNVERIFIED."
echo "  ok  no third-party version drift; the old tree may share this tree's package store"

step "materialize the shipped entry from $OLD_REF"
materialize_old_tree
echo "  ok  $OLD_TREE"

step "produce state through the SHIPPED entry ($OLD_ENTRY)"
boot "$OLD_TREE" "src/deployments/local/main.ts" old

# Two identities, so the later checks can show the new entry tells them apart
# rather than accepting any token as any user.
owner_bearer="$(signup upgrade-owner@claxedo.test "Upgrade Owner")"
owner_user="$(api /api/auth/get-session -H "authorization: Bearer $owner_bearer" | field user.id)"
[ -n "$owner_user" ] || fail "the shipped entry issued a token it cannot resolve to a user"
echo "  ok  embedded-auth user created: $owner_user"

other_bearer="$(signup upgrade-other@claxedo.test "Upgrade Other")"
other_user="$(api /api/auth/get-session -H "authorization: Bearer $other_bearer" | field user.id)"
[ -n "$other_user" ] && [ "$other_user" != "$owner_user" ] || fail "the shipped entry did not create a second distinct user"
echo "  ok  second embedded-auth user created: $other_user"

# The signing secret is generated once and persisted under the data root. It is
# the reason a token minted by the old build can be presented to the new one.
[ -s "$DATA_DIR/embedded-auth.secret" ] || fail "the shipped entry did not persist embedded-auth signing material"
secret_before="$(cat "$DATA_DIR/embedded-auth.secret")"
echo "  ok  signing material persisted at <dataDir>/embedded-auth.secret"

# A managed credential: encrypted secret material owned by the credentials
# store, written and read back through the app rather than off disk.
api /api/claxedo/credentials -X PUT -H "authorization: Bearer $owner_bearer" -H 'content-type: application/json' \
  -d '{"provider_id":"upgrade-probe-old","kind":"api_key","source":"local_only","label":"written by the shipped entry","secret":"old-entry-secret","scope":"local"}' \
  | field credential.id > "$WORK/cred-old.id"
[ -s "$WORK/cred-old.id" ] || fail "the shipped entry could not store a credential"
echo "  ok  credential stored: $(cat "$WORK/cred-old.id")"

# Local execution configuration: user agent config, persisted under the data
# root as user-agent-config.json.
expect "shipped entry accepts an MCP server config" 200 \
  "$(code /api/claxedo/agent-config/mcp/upgrade-probe-old -X POST -H "authorization: Bearer $owner_bearer" \
      -H 'content-type: application/json' -d '{"type":"stdio","command":"echo shipped","enabled":true}')"

# Characterize the route flows that must still answer the same way after the
# upgrade. Captured, not hardcoded, so the assertion is "unchanged", not "equal
# to whatever was true the day this was written".
harness_before="$(api /api/claxedo/agent-config/harness -H "authorization: Bearer $owner_bearer" | field id)"
engine_before="$(api /api/claxedo/bootstrap -H "authorization: Bearer $owner_bearer" | field engine_mode)"
sessions_before="$(code /api/control/session-list -H "authorization: Bearer $owner_bearer")"
echo "  ok  characterized: harness=$harness_before engine=$engine_before session-list=$sessions_before"

stop
echo "  ok  shipped entry stopped; data root retained at $DATA_DIR"

step "boot the NEW entry ($NEW_ENTRY) against that exact data root"
boot "$repo" "$NEW_ENTRY" new-1

step "identity continuity"
# The token was minted by the OLD build. Resolving it under the NEW build means
# the persisted signing secret still validates and the user/session rows in
# embedded-auth.sqlite were read, not recreated.
expect "owner token still resolves to the same user" "$owner_user" \
  "$(api /api/auth/get-session -H "authorization: Bearer $owner_bearer" | field user.id)"
expect "second user's token resolves to the second user" "$other_user" \
  "$(api /api/auth/get-session -H "authorization: Bearer $other_bearer" | field user.id)"
expect "signing material was reused, not regenerated" "$secret_before" "$(cat "$DATA_DIR/embedded-auth.secret")"

step "authorization continuity"
# /api/workspace/resolve separates three outcomes, and the separation is the
# assertion — a new entry that accepted any token, or no token, as the old owner
# would collapse them into one answer:
#   no bearer     -> 404. Loopback with no identity takes the unsigned-local
#                    path, which looks for a LOCAL workspace and finds none. It
#                    never consults the authority, so there is no role decision.
#   forged bearer -> 401. Signed auth is attempted and rejected; the embedded
#                    issuer will not validate a token it did not sign.
#   old bearer    -> 403 workspace_authorization_denied. Auth accepted a token
#                    minted by the PREVIOUS build, the request reached the
#                    workspace authority, and the denial is by ROLE on an
#                    unknown workspace. Reaching a role decision is the proof
#                    that identity survived far enough to be authorized.
expect "no bearer takes the unsigned-local path" 404 "$(code "/api/workspace/resolve?workspaceId=absent")"
expect "forged bearer is refused by signed auth" 401 "$(code "/api/workspace/resolve?workspaceId=absent" -H 'authorization: Bearer forged.token')"
denied="$(api "/api/workspace/resolve?workspaceId=absent" -H "authorization: Bearer $owner_bearer" | field error.code)"
expect "old bearer reaches the workspace authority" workspace_authorization_denied "$denied"

step "state and configuration continuity"
expect_contains "credentials written by the shipped entry" "upgrade-probe-old" \
  "$(api /api/claxedo/credentials -H "authorization: Bearer $owner_bearer")"
expect_contains "agent config written by the shipped entry" "upgrade-probe-old" \
  "$(api /api/claxedo/agent-config/mcp -H "authorization: Bearer $owner_bearer")"
expect "harness route unchanged"      "$harness_before"  "$(api /api/claxedo/agent-config/harness -H "authorization: Bearer $owner_bearer" | field id)"
expect "bootstrap route unchanged"    "$engine_before"   "$(api /api/claxedo/bootstrap -H "authorization: Bearer $owner_bearer" | field engine_mode)"
expect "session-list route unchanged" "$sessions_before" "$(code /api/control/session-list -H "authorization: Bearer $owner_bearer")"

step "mutate state through the NEW entry"
api /api/claxedo/credentials -X PUT -H "authorization: Bearer $owner_bearer" -H 'content-type: application/json' \
  -d '{"provider_id":"upgrade-probe-new","kind":"api_key","source":"local_only","label":"written after the upgrade","secret":"new-entry-secret","scope":"local"}' >/dev/null
expect "new entry accepts an MCP server config" 200 \
  "$(code /api/claxedo/agent-config/mcp/upgrade-probe-new -X POST -H "authorization: Bearer $owner_bearer" \
      -H 'content-type: application/json' -d '{"type":"stdio","command":"echo upgraded","enabled":true}')"
new_token="$(signup upgrade-post@claxedo.test "Upgrade Post")"
post_user="$(api /api/auth/get-session -H "authorization: Bearer $new_token" | field user.id)"
[ -n "$post_user" ] || fail "the new entry could not create a user in the upgraded data root"
echo "  ok  post-upgrade user created: $post_user"

stop

step "restart the NEW entry on the upgraded data root"
boot "$repo" "$NEW_ENTRY" new-2

# Both generations of state must survive together. Checking only the new writes
# would pass on a data root the upgrade had silently re-initialized.
expect "owner minted by the shipped entry still resolves" "$owner_user" \
  "$(api /api/auth/get-session -H "authorization: Bearer $owner_bearer" | field user.id)"
expect "user created after the upgrade still resolves" "$post_user" \
  "$(api /api/auth/get-session -H "authorization: Bearer $new_token" | field user.id)"
creds="$(api /api/claxedo/credentials -H "authorization: Bearer $owner_bearer")"
expect_contains "pre-upgrade credential"  "upgrade-probe-old" "$creds"
expect_contains "post-upgrade credential" "upgrade-probe-new" "$creds"
mcp="$(api /api/claxedo/agent-config/mcp -H "authorization: Bearer $owner_bearer")"
expect_contains "pre-upgrade config"  "upgrade-probe-old" "$mcp"
expect_contains "post-upgrade config" "upgrade-probe-new" "$mcp"
expect "old bearer still authorized against the authority" workspace_authorization_denied \
  "$(api "/api/workspace/resolve?workspaceId=absent" -H "authorization: Bearer $owner_bearer" | field error.code)"

stop
echo
echo "PASS: state produced by the shipped entry at $OLD_REF survives the upgrade to $NEW_ENTRY and a further restart"
