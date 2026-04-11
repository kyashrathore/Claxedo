---
title: "security: Hosted Secrets and Default-Deny Egress v1"
type: security
status: active
date: 2026-04-11
origin: /Users/yashvardhansingh/test/opencode/docs/plans/2026-04-10-credential-centralization-and-broker-plan.md
---

# security: Hosted Secrets and Default-Deny Egress v1

## Summary

This plan narrows the larger credential-centralization work into a shippable v1:

- hosted or cloud-deployed Claxedo uses a Cloudflare-backed managed secret store
- local desktop keeps a local secure backend and is not forced onto Cloudflare
- managed secrets are removed from `~/.claxedo/user-agent-config.json`
- untrusted sandboxes never receive managed secrets
- sandbox and remote workspace egress becomes deny-by-default
- users explicitly configure allowed outbound targets in the UI
- Cloudflare request proxying and brokered provider access are deferred to a later phase

This plan builds directly from the broader security plan in [2026-04-10-credential-centralization-and-broker-plan.md](/Users/yashvardhansingh/test/opencode/docs/plans/2026-04-10-credential-centralization-and-broker-plan.md).

## Problem Frame

The current system couples three concerns that need to be separated:

1. Managed secrets still live in plaintext local config via [agent-config.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.ts).
2. Sandbox provider auth is still persisted inside `sandbox.auth` and consumed directly by [provider.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/provider.ts).
3. Remote sandbox networking is permissive by default, rather than explicitly configured by the user.

For v1, the goal is not “safe remote provider execution.” The goal is:

- centralize managed secret ownership
- keep local desktop viable
- prevent managed secrets from entering untrusted sandboxes
- make remote egress explicit and auditable

## Scope

### In Scope

- Backend abstraction for deployment-specific secret backends
- Hosted path using Cloudflare-backed secret storage
- Local path using a local secure backend
- Migration of plaintext provider and sandbox auth out of `user-agent-config.json`
- Central provider and sandbox auth APIs backed by the credential registry
- Trusted-host fanout for Pi, OpenCode, ACP, and sandbox providers
- Network policy persistence and enforcement for cloud workspaces and sandboxes
- UI for outbound allowlists and blocked-by-policy states

### Out of Scope

- Cloudflare Worker request proxying
- Broker grants, lease issuance, or provider-compatible reverse proxying
- Delivering managed secrets into untrusted sandboxes
- Rebuilding every OpenCode OAuth flow from scratch
- Importing machine-local ACP logins into managed storage automatically

## Requirements Trace

- R1. No long-lived provider or sandbox secret remains in plaintext JSON config.
- R2. `claxedo-server` remains the canonical credential control plane.
- R3. Secret values and metadata remain separated.
- R4. Local desktop remains viable without Cloudflare-backed storage.
- R5. Untrusted sandboxes never receive managed secrets in v1.
- R6. Pi, OpenCode, ACP, and sandbox providers can consume centrally managed credentials on trusted hosts.
- R7. Existing local-only ACP login continues to work and is surfaced as unmanaged.
- R8. OpenCode subscription or OAuth artifacts move toward centralized storage.
- R9. Provider and sandbox settings reflect centralized credential state.
- R10. Metadata supports validation state, expiry, source, and audit fields.
- R11. Sandbox and remote workspace egress is deny-by-default.
- R12. Users can configure allowed outbound targets in the UI.

## Existing Patterns to Follow

### Server

- [agent-config.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.ts)
  - current persisted shape for `runner`, `auth`, and `sandbox`
- [routes/workspace.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/workspace.ts)
  - current sandbox provider settings routes
- [cloud/provider.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/provider.ts)
  - current sandbox provider auth resolution and client construction
- [routes/opencode-compat.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/opencode-compat.ts)
  - current provider auth surface for `/provider`, `/provider/auth`, and `/auth/:providerID`
- [cloud/sandbox-pool.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/sandbox-pool.ts)
  - current remote sandbox acquisition path that depends on sandbox provider auth
- [workspace-supervisor.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/workspace-supervisor.ts)
  - central place to pass runtime/bootstrap configuration into remote workspaces

### UI

- [acp-config.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/acp-config.ts)
  - current provider/runner state surface for the UI
- [agent-runner-selector.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx)
  - current runner and provider model selection behavior
- [rail-layout.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/layouts/rail-layout.tsx)
  - current cloud workspace flows and a likely home for new network or sandbox settings entry points

### Tests

- [agent-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.test.ts)
- [provider.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/provider.test.ts)
- [workspace-supervisor.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/workspace-supervisor.test.ts)
- [agent-runner-selector.vitest.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.vitest.tsx)
- [acp-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/acp-config.test.ts)

## Key Decisions

### 1. Backend selection is deployment-specific

- Hosted or cloud-deployed Claxedo uses Cloudflare-backed managed secret storage.
- Local desktop uses a local secure backend.
- `claxedo.db` stores only metadata and an opaque backend reference.

Rationale:
- This prepares hosted Claxedo without making local installs depend on Cloudflare availability.

### 2. Remote sandbox execution is network-controlled, not secret-enabled

- v1 remote sandboxes get network policy only.
- They do not get managed provider secrets.
- Secret-bearing provider execution remains trusted-host-only.

Rationale:
- This avoids pretending v1 solves safe remote provider access before a broker exists.

### 3. Network egress is explicit

- Remote workspaces and sandboxes deny outbound access by default.
- The user must configure exact hosts, wildcard domains, or curated provider presets.

Rationale:
- This gives a safe default and makes network access reviewable.

### 4. Unmanaged local ACP auth remains visible

- Existing local Claude/Codex/Cursor logins may continue to work.
- They are surfaced as `local_only`, not as managed credentials.

Rationale:
- This avoids breaking current local flows during migration.

## Implementation Units

- [ ] **Unit 1: Introduce credential and network metadata**

**Goal:** Add central metadata tables for managed credentials and outbound policy.

**Requirements:** R1, R2, R3, R10, R11

**Files:**
- Add: `packages/claxedo-server/src/storage/provider-credential.sql.ts`
- Add: `packages/claxedo-server/src/storage/network-policy.sql.ts`
- Modify: `packages/claxedo-server/src/storage/schema.ts`
- Modify: `packages/claxedo-server/src/storage/db.ts`
- Add migration: `packages/claxedo-server/src/storage/claxedo-migration/<timestamp>_provider_credentials/migration.sql`

**Approach:**
- Add metadata tables for:
  - credentials
  - network policy entries
- Store provider id, source, status, expiry, label, and opaque backend ref for credentials.
- Store workspace scope, target, kind, and constraints for network policy.
- Keep raw secret material out of SQLite entirely.

**Test files:**
- Extend: [agent-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.test.ts)
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/credentials/registry.test.ts`

**Test scenarios:**
- Credential metadata can be created, updated, listed, and deleted without storing raw secret material.
- Network policy entries reject malformed targets and unsupported kinds.
- Opaque backend references round-trip through the registry without exposing secret bytes.

- [ ] **Unit 2: Add deployment-specific secret backends and migrate plaintext config**

**Goal:** Replace plaintext `user.auth` and `sandbox.auth` storage with backend-managed storage.

**Requirements:** R1, R3, R4

**Files:**
- Add: `packages/claxedo-server/src/credentials/types.ts`
- Add: `packages/claxedo-server/src/credentials/store.ts`
- Add: `packages/claxedo-server/src/credentials/registry.ts`
- Add: `packages/claxedo-server/src/credentials/cloudflare.ts`
- Add: `packages/claxedo-server/src/credentials/local.ts`
- Add: `packages/claxedo-server/src/credentials/migrate.ts`
- Modify: `packages/claxedo-server/src/agent-config.ts`

**Approach:**
- Define a backend interface with:
  - `put`
  - `get`
  - `delete`
  - `probe`
- Implement:
  - Cloudflare backend for hosted/cloud deployment
  - local secure backend for desktop mode
- Migrate existing plaintext config on startup or first write.
- Keep non-secret runner and UI config in `user-agent-config.json`.

**Test files:**
- Extend: [agent-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.test.ts)
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/credentials/migrate.test.ts`
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/credentials/store.test.ts`

**Test scenarios:**
- Local desktop selects the local secure backend.
- Hosted mode selects the Cloudflare backend.
- Legacy plaintext auth migrates into the configured backend and is removed from saved config.
- Backend outage fails closed without silently writing plaintext secrets.

- [ ] **Unit 3: Rewire provider and sandbox settings APIs**

**Goal:** Make settings routes read and write through the centralized credential registry.

**Requirements:** R2, R6, R8, R9

**Files:**
- Modify: `packages/claxedo-server/src/routes/opencode-compat.ts`
- Modify: `packages/claxedo-server/src/routes/workspace.ts`
- Add: `packages/claxedo-server/src/routes/credential.ts`

**Approach:**
- Move provider writes off `config.auth` and `sandbox.auth`.
- Persist normalized metadata plus backend reference instead.
- Keep OpenCode interactive auth flows proxied where necessary, but capture resulting artifacts into managed storage when possible.
- Keep provider status responses source-aware:
  - `managed`
  - `local_only`
  - `needs_login`
  - `error`

**Test files:**
- Extend: [agent-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/agent-config.test.ts)
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/routes/credential.test.ts`
- Extend: [provider.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/provider.test.ts)

**Test scenarios:**
- API-key provider auth writes produce backend references, not plaintext config entries.
- Sandbox provider auth writes produce backend references, not nested `sandbox.auth`.
- Provider status reflects managed vs unmanaged sources accurately.
- OpenCode OAuth-capable providers can report a stored artifact without remaining upstream-only forever.

- [ ] **Unit 4: Keep secret fanout on trusted hosts**

**Goal:** Let trusted hosts consume centralized credentials while keeping untrusted sandboxes secret-free.

**Requirements:** R5, R6, R7

**Files:**
- Modify: `packages/claxedo-server/src/harness/pi-support.ts`
- Modify: `packages/claxedo-server/src/harness/pi-adapter.ts`
- Modify: `packages/claxedo-server/src/local-agent-engine.ts`
- Modify: `packages/workspace-runtime/src/adapters/acp.ts`
- Modify: `packages/claxedo-server/src/cloud/provider.ts`
- Modify: `packages/claxedo-server/src/cloud/sandbox-pool.ts`

**Approach:**
- Replace direct config reads with registry lookups.
- Materialize secrets only at trusted fanout points:
  - Pi runtime setup
  - ACP process spawn
  - OpenCode trusted-host config sync
  - sandbox provider SDK creation on trusted hosts
- Do not pass managed provider secrets into remote sandboxes.
- Continue surfacing unmanaged ACP local login as `local_only`.

**Test files:**
- Extend: [provider.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/provider.test.ts)
- Extend: [workspace-supervisor.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/workspace-supervisor.test.ts)
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/harness/pi-support.test.ts`

**Test scenarios:**
- Pi can consume managed credentials from the registry on a trusted host.
- ACP env injection reads from the registry instead of legacy config.
- Remote sandbox bootstrap omits managed provider secrets entirely.
- Machine-local ACP auth still works and is marked unmanaged.

- [ ] **Unit 5: Add explicit outbound network policy**

**Goal:** Enforce deny-by-default egress for remote workspaces and sandboxes.

**Requirements:** R5, R11, R12

**Files:**
- Add: `packages/claxedo-server/src/network/types.ts`
- Add: `packages/claxedo-server/src/network/policy.ts`
- Add: `packages/claxedo-server/src/routes/network-policy.ts`
- Modify: `packages/claxedo-server/src/workspace-supervisor.ts`
- Modify: `packages/claxedo-server/src/cloud/sandbox-runtime.ts`
- Modify: `packages/claxedo-server/src/cloud/sandbox-image.ts`

**Approach:**
- Introduce a first-class policy model:
  - exact host
  - wildcard domain
  - provider preset
- Resolve an effective policy per workspace.
- Pass only that policy into remote runtime/bootstrap paths.
- Deny outbound traffic unless it matches user-configured targets or required Claxedo control-plane endpoints.

**Test files:**
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/network/policy.test.ts`
- Extend: [workspace-supervisor.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/workspace-supervisor.test.ts)
- Extend: [sandbox-runtime.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-server/src/cloud/sandbox-runtime.test.ts)

**Test scenarios:**
- Unknown targets are blocked by default.
- Exact-host entries allow matching egress and reject non-matching hosts.
- Wildcard domains allow subdomains but not sibling roots.
- Provider presets expand to the expected target set.
- Required Claxedo control-plane endpoints remain reachable.

- [ ] **Unit 6: Add UI for managed auth status and outbound allowlists**

**Goal:** Make credential state and network policy visible and editable in the app.

**Requirements:** R7, R9, R12

**Files:**
- Modify: `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts`
- Modify: `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx`
- Modify: `packages/claxedo-app/src/claxedo-ui/layouts/rail-layout.tsx`
- Add: `packages/claxedo-app/src/claxedo-ui/components/network-policy-settings.tsx`
- Add: `packages/claxedo-app/src/claxedo-ui/components/sandbox-provider-settings.tsx`

**Approach:**
- Extend UI status semantics to include:
  - `managed`
  - `local_only`
  - `needs_login`
  - `blocked_by_policy`
- Add a settings surface for outbound allowlists.
- Distinguish clearly between:
  - credential configured
  - model selectable
  - remote egress allowed

**Test files:**
- Extend: [acp-config.test.ts](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/context/acp-config.test.ts)
- Extend: [agent-runner-selector.vitest.tsx](/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.vitest.tsx)
- Add: `/Users/yashvardhansingh/test/opencode/packages/claxedo-app/src/claxedo-ui/components/network-policy-settings.vitest.tsx`

**Test scenarios:**
- Managed provider status renders distinctly from unmanaged local ACP status.
- Blocked-by-policy state is shown even when a credential exists.
- Users can add, edit, and remove allowlist entries.
- Provider presets display clearly and persist correctly.

## Sequence

1. Add credential and network metadata tables.
2. Add backend selection and migrate plaintext config.
3. Rewire provider and sandbox settings APIs.
4. Rewire trusted-host fanout for Pi, OpenCode, ACP, and sandbox providers.
5. Add deny-by-default network policy and remote enforcement.
6. Add UI for auth status and outbound allowlists.

## Risks

- Hosted secret storage adds a Cloudflare dependency for hosted deployments.
  - Mitigation: keep backend selection explicit and preserve a local secure backend for desktop mode.

- Some remote flows will remain impossible in v1 because secrets cannot safely enter untrusted sandboxes.
  - Mitigation: keep those paths trusted-host-only and represent that clearly in the UI.

- OpenCode provider artifacts may be harder to capture centrally than plain API keys.
  - Mitigation: treat OpenCode artifact normalization as a dedicated compatibility subtask within Unit 3.

- Deny-by-default egress may feel overly restrictive without good presets and errors.
  - Mitigation: ship curated provider presets and explicit `blocked_by_policy` feedback from the first UI pass.

## Verification Strategy

- `packages/claxedo-server`
  - `bun typecheck`
  - route and registry tests for credentials and network policy
- `packages/workspace-runtime`
  - `bun typecheck`
  - ACP auth-injection regression coverage
- `packages/claxedo-app`
  - `bun typecheck`
  - UI tests for auth state and allowlist settings

## Deferred to Later Phases

- Cloudflare request proxying
- broker grants and short-lived lease issuance
- provider-compatible reverse proxy endpoints
- secret-bearing provider execution from untrusted sandboxes

