---
title: "Cloud Architecture Hardening"
status: active
type: reference-study
date: 2026-04-22
---

# Cloud Architecture Hardening

Comparative analysis of Claxedo's hosted workspace architecture against two
reference implementations:

- **Superset** (host-service model) — desktop-first cloud workspace IDE with
  provider injection, env isolation, and manifest-based process adoption
- **Open-Inspect** (background-agents) — background coding agent platform with
  Cloudflare Durable Objects control plane, Modal sandboxes, and per-session
  isolation

This doc does not restate problems already captured in
`brainstorms/2026-03-31-cloud-workspace-secret-boundary.md`. It covers the
broader set of architectural gaps beyond secrets.

Doc role:

- **Comparative analysis / reference study**
- informs but does not define the adopted target architecture

Related docs:

- [docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md)
- [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md)

The references below are evidence sources and pattern studies. A mention of
Durable Objects or another reference-system pattern should be read as
comparative input, not as an implicit endorsement of the adopted Claxedo
architecture.

---

## 1. No auth between control plane and workspace-runtime

### Current state

`workspace-runtime` has no inbound authentication. Every HTTP and WebSocket
endpoint is open to any caller who can reach the Daytona preview URL.

`claxedo-server` authenticates browser clients via Clerk JWT, but when it
proxies requests to the runtime, the runtime has no way to verify the request
came from the control plane.

The signed Daytona preview URL (24h TTL) is the only boundary.

### Why this matters

- Any process inside the sandbox can call any runtime endpoint
- If the preview URL leaks (logs, error messages, browser history), the entire
  workspace is accessible with no further auth
- The runtime cannot distinguish control-plane requests from in-sandbox
  requests, so it cannot enforce different privilege levels

### Reference patterns

**Superset** generates a random 32-byte PSK (`HOST_SERVICE_SECRET`) per
host-service instance. Every request to protected endpoints
(`/terminal/*`, `/workspace-filesystem/*`, `/trpc/*`) must carry
`Authorization: Bearer <secret>`. The PSK is generated at spawn, passed via
env, and never written to logs or user-visible surfaces.

**Open-Inspect** generates a per-sandbox auth token at the control plane
(`generateId()` → 32 random hex chars). The token is passed to the sandbox
via `SANDBOX_AUTH_TOKEN` env var. The sandbox sends it back in WebSocket
messages as `Authorization: Bearer {token}`. The control plane stores only
the SHA-256 hash and validates using `timingSafeEqual`. The token is
single-use per sandbox lifetime and never shared across sessions.

Both systems treat the auth token as a secret generated before the sandbox
exists and injected at spawn. Neither relies on a preview URL as a security
boundary.

### Recommendation

Add a per-sandbox PSK or short-lived token:

1. Generate a secret when acquiring a sandbox from the pool
2. Pass it to workspace-runtime via env (`CLAXEDO_WR_AUTH_SECRET`)
3. Add middleware to workspace-runtime that validates
   `Authorization: Bearer <secret>` on all non-health endpoints
4. Include the secret in proxy headers from `claxedo-server`
5. Store only the hash in claxedo-server state (follow Open-Inspect's pattern)
6. Do not include it in the Daytona preview URL or any user-visible surface

Health endpoints (`/api/wr/health`, `/global/health`) can remain public for
liveness probes.

---

## 2. Local runtime spawn leaks full process.env

### Current state

`workspace-supervisor.ts` spawns local workspace-runtime with:

```ts
const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  env: {
    ...process.env,
    CLAXEDO_WR_PORT: String(s.port),
    CLAXEDO_WR_WORKSPACE_ID: s.ws.id,
    CLAXEDO_WR_DIRECTORY: s.ws.directory,
    OPENCODE_URL: cfg.opencode_url,
  },
})
```

This spreads the entire `claxedo-server` process env into the child, including
`DAYTONA_API_KEY`, `MODAL_TOKEN_SECRET`, `CLERK_SECRET_KEY`,
`ENCRYPTION_KEY`, and any provider API keys present in the server env.

### Why this matters

- The local workspace-runtime inherits infrastructure secrets it does not need
- Any PTY spawned by workspace-runtime inherits those secrets transitively
- A user typing `env` in a terminal can see `CLERK_SECRET_KEY`
- This is the exact anti-pattern that Superset's v2 terminal env contract was
  designed to prevent

### Reference pattern

Superset builds the child process env explicitly:

1. Resolve a clean shell snapshot by spawning the user's login shell with a
   minimal parent env (`HOME`, `USER`, `SHELL`, `PATH`, `TERM` only)
2. Strip known runtime keys via denylist (`AUTH_TOKEN`, `CLOUD_API_URL`,
   `ELECTRON_*`, `VITE_*`, `npm_*`, etc.)
3. Add only the explicit keys the child needs
4. Fail if the clean shell snapshot cannot be resolved

### Recommendation

Replace `...process.env` with an explicit allowlist:

```ts
const child = spawn(process.execPath, args, {
  env: {
    // Shell essentials from a clean snapshot or explicit list
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    PATH: process.env.PATH,
    TERM: process.env.TERM ?? "xterm-256color",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    // Workspace-runtime config
    CLAXEDO_WR_PORT: String(s.port),
    CLAXEDO_WR_WORKSPACE_ID: s.ws.id,
    CLAXEDO_WR_DIRECTORY: s.ws.directory,
    OPENCODE_URL: cfg.opencode_url,
    // Node runtime
    NODE_ENV: process.env.NODE_ENV,
  },
})
```

Infrastructure secrets (`DAYTONA_API_KEY`, `CLERK_SECRET_KEY`,
`ENCRYPTION_KEY`, `MODAL_TOKEN_SECRET`) must never reach the child.

---

## 3. No credential hot-reload or rotation

### Current state

Credentials are pushed once on workspace start via `POST /api/wr/config`.
`broadcastRuntimeConfig()` can re-push, but there is no TTL, rotation, or
revocation mechanism.

If a provider key is rotated in the user's config, the running runtime keeps
the old key until it is manually restarted or a new config push happens.

### Why this matters

- Long-lived credentials in remote runtimes increase blast radius on compromise
- No way to force-revoke a credential from a running workspace
- No visibility into which workspaces hold which credential version

### Reference pattern

Superset's `CloudGitCredentialProvider` uses short-lived tokens with expiry:

```ts
constructor(
  tokenFetcher: (remoteUrl: string) =>
    Promise<{ token: string; expiresAt: number }>
)
```

Tokens are cached locally and re-fetched when expired. The upstream secret
never leaves the control plane.

### Recommendation

For proxy-safe providers (already identified in the secret boundary doc):

1. Do not push raw keys at all
2. Have workspace-runtime call back to the control plane to get short-lived
   scoped tokens on demand
3. Tokens should carry `workspaceId` scope and a tight TTL (5-15 minutes)

For mount-only providers (the exception path):

1. Push with explicit TTL metadata
2. workspace-runtime should discard credentials after TTL
3. Control plane should track which runtimes hold which credential version

---

## 4. No process lifecycle persistence

### Current state

All runtime state lives in `const runtimes = new Map<string, State>()` inside
`workspace-supervisor.ts`. If `claxedo-server` crashes or restarts:

- All runtime references are lost
- Running sandboxes become orphaned
- No re-adoption of running runtimes on restart
- The warm pool may leak sandboxes that are never cleaned up

### Why this matters

- Server restarts (deploy, crash, OOM) orphan cloud VMs that continue running
  and billing
- No way to discover and re-adopt a running workspace-runtime after restart
- Pool reconciliation only runs while the server is alive

### Reference pattern

Superset writes a manifest file per host-service instance:

```json
{
  "pid": 12345,
  "endpoint": "http://127.0.0.1:4879",
  "authToken": "<psk>",
  "serviceVersion": "1.2.3",
  "protocolVersion": 2,
  "startedAt": 1712345678000,
  "organizationId": "org_abc"
}
```

On restart, the desktop app:

1. Scans manifest directory
2. Health-checks each manifest endpoint
3. Adopts live processes (stores pid, port, secret)
4. Removes stale manifests and respawns
5. Checks protocol version compatibility and triggers graceful restart if needed

### Recommendation

Persist runtime state to SQLite (already available via `claxedo.db`):

```sql
CREATE TABLE workspace_runtime (
  workspace_id TEXT PRIMARY KEY,
  sandbox_id TEXT,
  sandbox_url TEXT,
  auth_secret TEXT,
  status TEXT,
  started_at INTEGER,
  last_health_at INTEGER
);
```

On server startup:

1. Query `workspace_runtime` for rows with `status = 'ready'`
2. Health-check each `sandbox_url`
3. Re-adopt live runtimes into the in-memory map
4. Mark dead runtimes for cleanup
5. Reconcile against Daytona sandbox list to catch leaked VMs

---

## 5. Terminal env is uncontrolled inside sandboxes

### Current state

workspace-runtime spawns PTYs via `node-pty` but does not filter or construct
the PTY environment. Whatever env the runtime process inherited becomes the
terminal env.

In cloud mode, the runtime process env includes:

- `CLAXEDO_WR_PORT`, `CLAXEDO_WR_WORKSPACE_ID`, `CLAXEDO_WR_DIRECTORY`
- Any raw auth keys pushed via `/api/wr/config` and applied via
  `adapter.setAuth()` or `adapter.applyConfig()`

These are visible to users in terminal sessions via `env` or `printenv`.

### Reference pattern

Superset's `buildV2TerminalEnv()`:

1. Starts from a pre-captured clean shell snapshot
2. Strips all runtime keys via explicit denylist
3. Adds only terminal-relevant vars (`TERM`, `COLORTERM`, `LANG`, `PWD`)
4. Adds explicit workspace metadata (`SUPERSET_TERMINAL_ID`,
   `SUPERSET_WORKSPACE_ID`)
5. Never includes auth tokens, API keys, or service credentials
6. Applies stripping twice (at init and at PTY construction) as defense in depth

### Recommendation

Add a PTY env builder to workspace-runtime:

1. Capture a clean base env at runtime startup (before config is applied)
2. When spawning PTYs, start from the clean base env
3. Strip `CLAXEDO_WR_*`, any `ANTHROPIC_*`, `OPENAI_*`, and config-derived keys
4. Add terminal-standard vars and workspace identity
5. Never let config-pushed auth keys reach PTY processes

---

## 6. No fail-closed behavior or circuit breaking on critical failures

### Current state

Multiple paths degrade silently:

- `resolveServiceUrl()` falls back to the first candidate URL even if health
  checks fail
- Config push failures are caught and logged but the runtime stays in service
- Pool acquisition failures trigger backoff but no circuit-breaking
- SSE stream disconnections reconnect silently with no upper bound on retries

### Reference patterns

**Superset** fails closed on critical paths:

- Shell env resolution failure blocks terminal creation entirely
- No fallback to `process.env` under any circumstances
- `ctx.api` being null causes workspace creation to throw
  `PRECONDITION_FAILED` rather than silently operating without cloud sync

**Open-Inspect** implements a full circuit breaker with pure decision
functions (`evaluateCircuitBreaker`, `evaluateSpawnDecision`,
`evaluateConnectingTimeout`, `evaluateHeartbeatHealth`):

- Tracks `spawn_failure_count` and `last_spawn_failure` in persisted SQLite
- After N consecutive failures, blocks spawn attempts for escalating cooldowns
- Resets on successful spawn
- Classifies errors as `permanent` vs `transient` — only permanent errors
  increment the breaker
- Connecting timeout: if sandbox stays "connecting" >30s, fails the sandbox
  instead of blocking
- Heartbeat stale check: if no heartbeat >60s, marks sandbox stale
- All decisions are pure functions that return `{ action, reason }`, making
  them independently testable

This is the most mature failure-handling pattern of the three systems.

### Recommendation

Adopt a circuit breaker pattern:

**Terminal (fail closed):**

- Sandbox health check fails after max retries: do not return a URL to the
  proxy layer
- Config push fails on initial start: mark runtime as failed, do not serve
  requests
- Runtime auth secret mismatch: reject and re-provision

**Circuit breaker (bound failures):**

- Track consecutive spawn failures per workspace in SQLite
- After 3 permanent failures, disable spawning with exponential cooldown
- Reset on any successful spawn
- Surface breaker state to the user ("Sandbox temporarily unavailable")

**Retriable (with bounds):**

- SSE stream disconnection: retry with exponential backoff, cap at 5 minutes,
  emit degraded status after 3 failures
- Pool acquisition: retry with backoff, but surface the failure to the user
  after 30 seconds instead of blocking indefinitely

Consider extracting decision logic into pure functions (following
Open-Inspect's pattern) to make failure behavior testable without spinning up
real sandboxes.

---

## 7. No workspace-scoped event isolation

### Current state

`globalBus` is a single `Set<EventSink>`. All events from all workspaces are
broadcast to all connected SSE clients. The browser filters by directory.

### Why this matters

- Multi-workspace scenarios broadcast cross-workspace events to all listeners
- No server-side filtering means unnecessary bandwidth and potential
  information leakage between workspaces in a multi-tenant context
- Directory remapping (remote to local) is applied globally rather than
  per-subscription

### Recommendation

Add workspace-scoped event channels:

1. SSE clients subscribe with `?workspaceId=<id>`
2. Server-side filtering: only send events matching the subscribed workspace
3. Keep `/global/event` as a fan-in endpoint for backward compatibility, but
   add `/workspace/:id/event` for scoped subscriptions
4. Apply directory remapping per-workspace rather than globally

---

## 8. Config push is a single atomic blob

### Current state

`RuntimeSnapshot` is one JSON object containing MCP config, runner config, and
all auth keys. It is pushed atomically. If any part fails to apply, the
entire config is rejected.

### Why this matters

- Changing the runner type forces re-pushing all auth keys
- Adding an MCP server forces re-pushing all auth keys
- No way to update auth independently of runner/MCP config
- The snapshot grows linearly with provider count

### Recommendation

Split config into independent channels:

1. `POST /api/wr/config/runner` for runner type, binary, model
2. `POST /api/wr/config/mcp` for MCP server configuration
3. `POST /api/wr/config/auth` for credentials (or better: remove this
   entirely per the secret boundary doc)
4. Keep `POST /api/wr/config` as a convenience for full-snapshot push but
   allow partial updates

---

## 9. No per-session isolation of control plane state

### Current state

Claxedo-server runs as a single process with all workspace state in one
in-memory map and one SQLite database. All workspaces share the same process,
the same event bus, and the same failure domain.

If the server crashes, all workspaces lose their runtime references. A memory
leak or CPU spike in one workspace's event processing affects all workspaces.

### Reference pattern

Open-Inspect uses **Cloudflare Durable Objects** — one DO instance per
session. Each DO has its own SQLite database, its own WebSocket connections,
its own alarm scheduler, and its own lifecycle state. A crash in one session's
DO does not affect others. The DO hibernates when inactive and wakes on
incoming requests, with WebSocket state recovered via hibernation tags.

This gives session-level isolation without running separate processes per
session. The control plane is stateless — it routes requests to the
appropriate DO and the DO owns all session state.

### Why this matters for Claxedo

- The `vm-control-plane-workstreams.md` doc already identifies that
  control-plane fragility needs fixing
- Process-local `Map<string, State>` is the fragile surface
- As workspace count grows, blast radius per crash grows linearly

### Recommendation

This does not require adopting Durable Objects. But the core insight is
worth extracting: **session state should survive server restarts**.

Options (in order of increasing effort):

1. Persist runtime state to SQLite (section 4 above) — minimum viable
2. Move per-workspace state into isolated storage units with independent
   lifecycle — each workspace's state reconstructible from persisted data
3. If scaling demands it, consider a per-workspace worker or DO model where
   each workspace runs in its own failure domain

---

## 10. No encrypted-at-rest credential storage

### Current state

Claxedo stores user agent config (including provider credentials) in
`~/.claxedo/user-agent-config.json` as plaintext JSON. The `ENCRYPTION_KEY`
env var exists and an `encrypt`/`decrypt` function pair exists in the
orchestrator, but credentials are not consistently encrypted before storage.

### Reference pattern

Open-Inspect encrypts all sensitive data at rest using AES-256-GCM:

- GitHub OAuth tokens encrypted with `TOKEN_ENCRYPTION_KEY` before storage
  in the participants table
- Repo secrets encrypted with `REPO_SECRETS_ENCRYPTION_KEY` in D1
- Code-server passwords encrypted before storage in the sandbox row
- Keys are base64-encoded 256-bit secrets, generated via
  `openssl rand -base64 32` and managed through Terraform
- Separate encryption keys for different secret categories
  (user tokens vs repo secrets)

Superset's `CloudGitCredentialProvider` avoids the problem entirely by
never persisting credentials — it fetches short-lived tokens on demand and
caches them in memory with expiry.

### Recommendation

1. Encrypt provider credentials before writing to
   `user-agent-config.json` using the existing AES-256-GCM helpers
2. Use the `ENCRYPTION_KEY` consistently — every secret written to disk or
   SQLite should go through `encrypt()`
3. Consider separating encryption keys per secret category (user auth
   tokens vs provider API keys vs MCP auth) to limit blast radius if one
   key is compromised
4. Long term: move toward Superset's model where upstream secrets stay in
   the control plane and only scoped short-lived tokens are issued

---

## 11. No sandbox filesystem snapshot or session persistence

### Current state

When a Daytona sandbox is stopped (idle timeout, manual stop, crash), all
filesystem state is lost. There is no snapshot mechanism. Restoring a
workspace means re-cloning the repo, re-running setup, and losing any
uncommitted work.

### Reference pattern

Open-Inspect uses Modal's `snapshot_filesystem()` API to capture full
sandbox state:

- Snapshots taken: after each prompt completion, before idle timeout, on
  explicit trigger
- Snapshots are incremental (diff from base image), stored in Modal registry
- Restore creates a new sandbox from the snapshot image — seconds vs minutes
- Snapshot IDs stored in the session's SQLite with `base_sha` for git state
  tracking
- Image priority on spawn: session snapshot > repo image > base image

This enables "close your laptop, come back tomorrow, resume exactly where
you left off" workflows.

### Why this matters for Claxedo

- Interactive workspaces accumulate state: uncommitted changes, installed
  dependencies, running processes, terminal history
- Losing this state on idle timeout forces users to re-setup every time
- The `sandboxImages` concept exists in the schema (setup commands, base
  image, system packages) but there is no runtime snapshot mechanism

### Recommendation

1. Check if Daytona SDK supports filesystem snapshots (similar to Modal's
   `snapshot_filesystem()`)
2. If yes: snapshot before idle shutdown, store image ID in workspace row,
   restore from snapshot on next start
3. If no: evaluate whether Modal should replace or supplement Daytona for
   workspaces that need persistence
4. Define snapshot triggers: before idle stop, after config change, manual
   save, before sandbox version upgrade

---

## 12. Env var construction does not separate user vars from system vars

### Current state

In `sandbox/manager.py`, user-provided env vars are merged with system vars
in a single dict:

```python
env_vars: dict[str, str] = {}
if config.user_env_vars:
    env_vars.update(config.user_env_vars)
env_vars.update({
    "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
    "CONTROL_PLANE_URL": config.control_plane_url,
    ...
})
```

System vars override user vars (correct precedence). But user vars and
system vars share the same namespace with no protection against collision
or inspection.

### Reference pattern

Open-Inspect follows the same merge pattern but adds two protections
Claxedo lacks:

1. **Git stderr redaction**: The bridge process explicitly redacts tokens
   from git error output before forwarding to the control plane
2. **System var override**: System vars always win over user vars,
   documented as intentional (user cannot override `SANDBOX_AUTH_TOKEN`)
3. **Build mode isolation**: Image build sandboxes explicitly omit
   `CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, and LLM secrets — the
   build sandbox gets only what it needs for `setup.sh`

Superset goes further with a complete env boundary: clean shell snapshot →
denylist strip → explicit additions only.

### Recommendation

1. Redact known sensitive values (`SANDBOX_AUTH_TOKEN`,
   `CLAXEDO_WR_AUTH_SECRET`, provider API keys) from any log output,
   error messages, or event payloads forwarded from the runtime
2. For local mode, do not pass system vars that the workspace-runtime
   does not need (section 2 above)
3. For cloud mode, document which system vars are injected and why, so
   the boundary is explicit rather than implicit

---

## Summary: priority order

All items from the original analysis plus new items from the Open-Inspect
comparison.

| Priority | Gap | Risk | Effort |
|----------|-----|------|--------|
| P0 | Runtime has no inbound auth | Critical: any reachable caller has full access | Low |
| P0 | Local spawn leaks `process.env` | Critical: infrastructure secrets in user terminals | Low |
| P1 | No credential rotation/TTL | High: long-lived secrets in remote VMs | Medium |
| P1 | No process lifecycle persistence | High: server restart orphans VMs | Medium |
| P1 | Terminal env leaks config-pushed secrets | High: API keys visible in `env` | Medium |
| P2 | No fail-closed on critical paths | Medium: silent degradation | Low |
| P2 | No workspace-scoped events | Medium: cross-workspace leakage | Medium |
| P3 | Config push is monolithic | Low: operational friction | Low |
