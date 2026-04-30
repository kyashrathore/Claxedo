---
title: Agent Runner Registry (single declarative config, zero-code ACP extension)
type: feat
status: active
date: 2026-04-22
deepened: 2026-04-22
origin: docs/brainstorms/2026-04-22-agent-runner-registry-requirements.md
---

# Agent Runner Registry

## Overview

Collapse claxedo's three parallel agent-runner paths (opencode-server, ACP clients, pi brain/hand) and three config stores (frontend localStorage, `~/.claxedo/user-agent-config.json`, `~/.claxedo/agent-core/session-runners.json`) into a single declarative JSON registry at `~/.claxedo/config.json`, modeled on paseo.sh's `agents.providers` design. Built-in providers become default-shipped entries in that file. Adding a new ACP client (e.g. Gemini, Hermes) requires zero code changes — just a new entry. Profiles (multiple entries sharing an `extends`) become first-class. Session records store `{providerId, modelId}` inline. The `AgentAdapter` → `CompatEvent` event-translation layer is preserved unchanged.

## Problem Frame

See origin: `docs/brainstorms/2026-04-22-agent-runner-registry-requirements.md`. The current architecture duplicates runner identity in four places (`packages/claxedo-server/src/agent-config.ts:76-77`, `packages/workspace-runtime/src/adapters/index.ts:54-58`, `packages/workspace-runtime/src/routes/config.ts:6-10`, `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:7`) plus ~7 inline `validTypes` arrays across routes and adapter dispatch. Adapter dispatch is duplicated across three factory sites (`workspace/full.ts:91-99`, `local-agent-engine.ts:121-133`, `harness/pi-host.ts:11-17`). Runner configuration straddles disk (`user-agent-config.json`, `session-runners.json`) and browser (`claxedo:runner-map` + 5 related keys), with a read path of `session → request → user → default` and no single source of truth. Adding a new ACP requires coordinated edits across all those surfaces; hand-editing the files breaks undocumented invariants.

## Requirements Trace

Origin doc defines R1-R8 and S1-S5 (see origin). This plan satisfies them as follows:

- **R1** (single config file = source of truth) → Units 1, 3, 4
- **R2** (built-ins as registry entries; ACPs via `extends: "acp"`) → Units 1, 2, 7
- **R3** (profiles first-class) → Units 1, 2, 5
- **R4** (process-lifetime immutability; no in-app writes) → Unit 3 (routes become read-only for provider data), Unit 5 (frontend never persists provider list)
- **R5** (per-session runtime selection; lift session-lock; fork-on-switch) → Unit 4
- **R6** (no localStorage as source-of-truth) → Unit 5
- **R7** (session-level selection inline on session record) → Unit 4
- **R8** (old runner IDs keep resolving) → Unit 7 (default registry preserves `claude-acp` / `codex-acp` / `cursor-acp` / `opencode` / `pi` as built-in providerIds) + Unit 4 (backward-compat parse of session-runners.json)
- **S1** (zero-code ACP addition) → Verified by Unit 7 test: add Gemini-ACP entry to fixture config, session creates, CompatEvents stream
- **S2** (profiles work) → Unit 5 test + Unit 1 test
- **S3** (fresh install has zero config) → Unit 1 test: missing file → pure defaults
- **S4** (legacy paths deleted) → Unit 6 CI grep check
- **S5** (switch-after-create no longer errors) → Unit 4 test

## Scope Boundaries

Explicitly out of scope for v1 (deferred per origin doc):

- CLI parity (`claxedo run --provider X`).
- Port allocator / name-based reverse proxy (`*.localhost` routing).
- Explicit user-facing `runsOn` field. Each built-in has a private `_harnessMode` on its default entry; custom providers inherit `acp` → workspace host. No user schema for this.
- True hot-swap of conversation history across providers. Switching forks.
- Migration of user-customized content in `user-agent-config.json` (beyond `runner` field). MCP and auth sections in that file stay until credential-centralization migrates them.
- Migration of user-edited `~/.paseo` config. This feature ships for claxedo; paseo is reference only.
- `CLAXEDO_HOME` / `$PROVIDERS_FILE` overrides. Single hardcoded path.
- The `AgentAdapter` interface. Frozen.

## Context & Research

### Relevant Code and Patterns

**Current runner surface (to be collapsed):**
- Union declarations: `packages/claxedo-server/src/agent-config.ts:76-77` (authoritative), `packages/workspace-runtime/src/adapters/index.ts:54-58`, `packages/workspace-runtime/src/routes/config.ts:6-10`, `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:7`
- Inline `validTypes` arrays: `routes/agent-config.ts:234`, `routes/opencode-compat.ts:77, 600`, `runner-resolution.ts:18-33`, `agent-runner-selector.tsx:12`
- Three adapter dispatch sites: `packages/workspace-runtime/src/workspace/full.ts:91-99`, `packages/claxedo-server/src/local-agent-engine.ts:121-133`, `packages/claxedo-server/src/harness/pi-host.ts:11-17`
- Binary resolvers: `packages/claxedo-server/src/agent-config.ts:85-101` (`cursorBinary`, `acpBinary` for claude/codex), `packages/workspace-runtime/src/workspace/full.ts:30-42` (duplicate fallback)
- Hardcoded model/auth env maps: `packages/workspace-runtime/src/adapters/acp.ts:65-76` (`MODEL_ENV_VARS`, `AUTH_ENV_VARS`), `packages/claxedo-server/src/harness/pi-support.ts:5-9` (`AUTH_MAP`)
- Hardcoded claude model list: `packages/claxedo-server/src/routes/agent-config.ts:69-73` (`CLAUDE_MODELS`)
- Frontend labels: `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx:13-19` (`RUNNER_LABELS`), `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:10-19` (`ACP_DISPLAY_NAMES`)

**Config storage (to be consolidated):**
- `packages/claxedo-server/src/agent-config.ts:37,54-62,105-119` (`loadUserConfig` / `saveUserConfig` on `~/.claxedo/user-agent-config.json`)
- `packages/claxedo-server/src/session-runner.ts:18-137` (`session-runners.json` with `Map<wsId:sessionId, Row>` cache, `Row.config = {runner, model, variant, agent}`)
- Frontend localStorage: `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:21-26,107-129` (`claxedo:runner-map`, `claxedo:acp-model-map`, `claxedo:agent-mode-map`, plus legacy singletons)

**Patterns to follow:**
- Zod schema + codec at persistence boundary: `packages/workspace-runtime/src/process/process.ts` (per `docs/plans/2026-04-09-workspace-runtime-type-refactor-plan.md:45-74`).
- Session storage split (metadata SQLite + config JSON): `packages/claxedo-server/src/session-meta.ts:229,292` + `session-runner.ts`.
- Adapter lifecycle idle-timeout pattern: `packages/workspace-runtime/src/adapters/opencode.ts:34-37` and `acp.ts:93-96` (env-configurable, default 5 min).
- `AgentAdapter` contract: `packages/workspace-runtime/src/adapters/index.ts:74-122` (stable).
- Real-binary integration test pattern: `packages/claxedo-server/src/real-acp-boot.integration.test.ts`.

### Institutional Learnings

- **Clean cutover over dual-read.** Multi-backend migration (`docs/multi-backend-migration.md:110-134`, `docs/multi-backend-migration-implementation.md:11-19,121-125`) established that compatibility shims for config schema changes introduce worse bugs than the cutover they avoid. Delete old readers entirely.
- **Identifier contract lock during topology changes.** Same migration (`docs/multi-backend-migration-implementation.md:126-139`) froze auth/provider IDs while topology shifted. This plan preserves `claude-acp` / `codex-acp` / `cursor-acp` / `opencode` / `pi` as literal providerIds; only the containing structure moves.
- **Zod-as-source-of-truth for on-disk types.** `docs/plans/2026-04-09-workspace-runtime-type-refactor-plan.md:45-74` — derive TS types from Zod, codec at read boundary, validate both on read AND on write. Four drifting type sources (SDK, ACP SDK, local unions, stringly rows) caused the prior drift.
- **No compatibility barrels when collapsing writers.** `docs/plans/2026-04-10-agent-hooks-consolidation-plan.md:49,332-334` explicitly rejected barrel re-exports when collapsing duplicate ownership. Apply: no thin wrappers around old API paths; delete routes outright, let 404s surface stale clients.
- **Credential-centralization overlap.** `docs/plans/2026-04-10-credential-centralization-and-broker-plan.md:204-234,297-327` moves auth out of `user-agent-config.json` into `claxedo.db` metadata tables. Profiles in this plan overlap with its `provider_id + kind + source` fields. Coordinate rather than fork (see Dependencies).
- **Pre-navigation guards over post-mount reactive gates.** `docs/bug-reports/2026-04-13-cloud-new-session-bootstrap-regression.md:53-86` — guard at the action layer. New session creation must not fire before the registry loads; add action-layer guard, assert first-visible state in tests.
- **Read SDK docs per ACP before freezing schema.** `memory/feedback_no_duct_tape.md` — each ACP binary has different auth injection surfaces (env-at-spawn, config-dir file, RPC). Registry's declarative shape must actually cover all observed seams.
- **`bun run test` (not `bun test`).** `packages/claxedo-app` needs `--conditions=browser`; without it, SolidJS effects silently no-op. Integration tests spawn real binaries.

### External References

- Paseo provider schema (reference): [getpaseo/paseo/docs/CUSTOM-PROVIDERS.md](https://github.com/getpaseo/paseo/blob/main/docs/CUSTOM-PROVIDERS.md) — vocabulary we adopt: `extends`, `label`, `description`, `command`, `env`, `models`, `enabled`, `order`, `disallowedTools`.
- Paseo port allocator (reference only, NOT in v1): `packages/server/src/utils/worktree.ts` `getAvailablePort` / `assertPortAvailable` pattern. Captured for future work.

## Key Technical Decisions

1. **Config file = `~/.claxedo/config.json`, JSON format.** Matches paseo, matches existing claxedo `*.json` config files, zero parser dep, no comment support needed in v1 (add JSONC only if users request it).
2. **Schema vocabulary = paseo verbatim.** `extends: "opencode" | "pi" | "acp"`, `label`, `description?`, `command?: string[]`, `env?: Record<string, string>`, `models?: Array<{id, label, isDefault?, description?}>`, `disallowedTools?: string[]`, `enabled?: boolean` (default `true`), `order?: number`. Enables copy-paste between paseo and claxedo configs for common cases.
3. **Three `extends` values in v1, not five.** Paseo's `claude` / `codex` / `copilot` built-ins collapse to `extends: "acp"` with specific pinned `command`/`env` for built-in entries. Three adapter classes (`OpenCodeAdapter`, `ACPAdapter`, `PiAdapter`) remain; the `extends` axis maps 1:1 to adapter class.
4. **Built-in providerIds preserve legacy runner IDs exactly.** `claude-acp`, `codex-acp`, `cursor-acp`, `opencode`, `pi`. No renames. R8 holds via identifier equivalence; no mapping table needed.
5. **Session record shape: `{providerId, modelId?, variant?, agent?}` inline.** Replaces `{runner: {type, binary, model}, variant, agent}`. `binary` is no longer persisted — derived from registry at adapter-spawn time.
6. **Session-runners.json: keep the file, rewrite its row shape.** Backward-compat parser on first read transforms old `{runner: {type, model}}` rows → new `{providerId, modelId}` rows. Writes always use new shape. Not considered a "user customization migration" — this is preserving session state, distinct from the origin doc's OOS `user-agent-config.json` migration.
7. **`user-agent-config.json` loses its `runner` field.** The field stops being read/written by the new provider-resolution path. The file itself stays (for `mcp`, `auth`, `sandbox`, pending credential-centralization). Presence of `runner` in an existing file is ignored, not migrated.
8. **Frontend localStorage: delete all six keys** (`claxedo:runner-map`, `claxedo:acp-model-map`, `claxedo:agent-mode-map`, `claxedo:runner`, `claxedo:acp-model`, `claxedo:agent-mode`). No ephemeral "last-used" cache in v1 — server returns a deterministic default.
9. **Private `_harnessMode` on built-in default entries only.** Not in user-editable schema. Resolves `runsOn` deferral: `opencode → workspace`, `pi → central`, `acp → workspace`. Loader strips/ignores `_harnessMode` on user-supplied entries.
10. **Minimal credential-ref surface in v1, aligned with credential-centralization.** Credential-centralization (`docs/plans/2026-04-10-credential-centralization-and-broker-plan.md`) has substantially shipped in code (`packages/claxedo-server/src/credentials/{types,store,registry,sync}.ts` exist; `resolveSecret(providerId)` is live; `pi-support.ts` already reads from it). Schema therefore adds two additively-safe optional fields now: `credentialRef?: string` (explicit credential-registry provider_id to resolve) and `authProvider?: string` (credential-group key — e.g., `"anthropic"` / `"openai"` / `"cursor"` — used when the same credential backs multiple registry entries). User profiles can still supply literal `env` values; `credentialRef`/`authProvider` are opt-in. Built-in defaults use `authProvider` instead of the `$internal:*` sigil scheme originally sketched.
11. **Switch-on-live-session = fork.** Changing the provider on an existing session creates a new session record under the new provider; the old session remains addressable but stops being the "current" one. No cross-provider history transfer. UI surfaces the new session as active.
12. **Registry is process-lifetime immutable.** Loaded once at gateway startup. No file-watcher. No hot reload. Edit + restart.
13. **Zod schema is the single source of truth** for `ProviderEntry`. TS types derived via `z.infer`. Codec lives at the file-read boundary.
14. **Two factories + thin caller dispatch, not one unified factory.** `createLocalAdapter(provider)` in `packages/workspace-runtime/src/adapters/factory.ts` handles `extends: "opencode" | "acp"` (these share workspace-runtime's package scope and need no `SyncDB`). `createCentralAdapter(provider, { workspace, sync })` in `packages/claxedo-server/src/providers/factory.ts` handles `extends: "pi"` via `getHarnessHost(sync).createAdapter(workspace)`. The call site (`agent-session.ts:178`-style) branches on `_harnessMode` and picks the factory — matching the existing code topology and avoiding a `workspace-runtime` → `claxedo-server` layering inversion. `createLocalAdapter` throws an invariant error if called with `extends: "pi"`.
15. **`CLAXEDO_HARNESS_MODE` env override is preserved; `user-agent-config.json.harness.mode` is removed.** Env-level override is valuable (CI, test harnesses, local-dev pinning). Config-level override was redundant with runner-type derivation and becomes unnecessary once `_harnessMode` lives on the provider entry. `getHarnessMode()` thin wrapper survives; its inputs shrink from (env → user-config → default-runner derivation) to (env → `_harnessMode` on default provider).
16. **"Central" means pi, in v1.** `_harnessMode: "central"` is set only on the built-in `pi` entry. The `createCentralAdapter` branch calls `getHarnessHost(sync)`, whose only current implementation is `createPiHost`. Custom user providers cannot declare `_harnessMode: "central"` (user schema omits the field). Generalizing to a pluggable `HarnessHost` registry keyed by provider id is explicitly out of scope — YAGNI until a second central provider exists.
17. **Spawn-time credential resolution replaces `_acpAuthKeys`.** Today's module-level `_acpAuthKeys = { anthropic, openai, cursor }` in `adapters/acp.ts:79` leaks wrong-tenant credentials across profiles sharing a binary (e.g., `claude-work` would inherit the built-in `claude-acp`'s key). `createLocalAdapter` composes env per-spawn by spreading `provider.env` (literal user values) and overlaying `resolveSecret(provider.credentialRef ?? provider.authProvider ?? provider.id)` into the slot named by `AUTH_ENV_VARS[basename(provider.command[0])]`. `MODEL_ENV_VARS` / `AUTH_ENV_VARS` stay keyed by binary basename (correct — they answer "which env var does this binary read?"). `_acpAuthKeys` and `setAcpAuth()` are deleted.

## Open Questions

### Resolved During Planning

- **Fork vs continue on live-session provider switch?** Fork. Matches paseo's multi-agent model; avoids cross-provider history-transfer tar pit; R5 OOS list in origin.
- **Schema vocabulary — adopt paseo verbatim or adjust?** Verbatim, plus two claxedo-specific optional fields (`credentialRef`, `authProvider`) to integrate with the shipped credential registry.
- **Credential-ref in v1 schema?** Yes — minimally. `credentialRef?: string` and `authProvider?: string` on `ProviderEntrySchema`, both optional. Built-in defaults use `authProvider` (e.g., `"anthropic"` on `claude-acp`). User profiles may use either or neither (falling back to literal `env`).
- **`runsOn` representation?** Private `_harnessMode` on built-in defaults only; not in user schema. Matches "implicit per built-in" from origin. In v1, the only `_harnessMode: "central"` entry is `pi`.
- **Single factory vs. two factories for adapter dispatch?** Two factories + caller dispatch (see Key Decision 14). Avoids workspace-runtime → claxedo-server layering inversion and keeps pi's HarnessHost indirection as a separate concern.
- **`CLAXEDO_HARNESS_MODE` env survives?** Yes (see Key Decision 15). `user-agent-config.json.harness.mode` does not.
- **Frontend cache state classification (origin deferred q #5)?** Delete all six keys. No ephemeral "last-used" in v1. Server default is deterministic.
- **Non-string runner fields in session records (origin deferred q #4)?** Yes — `session-runners.json` stores `{runner: {type, binary, model}}`. Backward-compat parser in Unit 4 handles the one-shot shape transform.
- **CI grep check location (origin deferred q #6)?** New `script/check-legacy-paths.ts` invoked from a new `.github/workflows/lint.yml` (there is currently no PR-gating workflow). Detailed in Unit 6.
- **Atomic write story for session-runners.json?** New shared helper `writeJsonAtomic(path, data)` in `packages/claxedo-server/src/paths.ts`. Existing `saveUserConfig` (`agent-config.ts:121-125`) also switches to it — the current `writeFile` is not atomic, which is a pre-existing bug this refactor fixes in passing. Advisory-lock via the existing `packages/shared/src/util/flock.ts` primitive wraps both writers.

### Deferred to Implementation

- **Exact Zod schema refinements** (e.g., whether `command: string[]` requires `.min(1)`, whether `env` values need non-empty strings). Unit 1 — start with the loosest valid shape, tighten as integration tests surface real failures.
- **Whether the availability probe is cached or always-live.** Unit 3 — default to a short TTL (e.g., 30s) behind an env flag; tune based on UI polling frequency observed during Unit 5 integration.
- **How `agent-runner-selector.tsx` groups profiles visually** (flat list sorted by `order` vs. grouped by `extends`). Unit 5 — start flat sorted, consider grouping if user testing shows confusion.
- **Whether to surface fork-vs-original in the session list after a provider switch.** Unit 4 — default is both sessions remain; UX for "archived on fork" can land as Unit 5 follow-up.
- **Handling of sessions created before this change whose `modelId` referred to a now-disabled provider.** Unit 4 — on resolution error, log + fall back to default provider for that session; don't crash.
- **Exact directory restructure in `packages/claxedo-server/src`** (e.g., new `providers/` subdir vs. flat). Unit 1 — pick whatever fits with existing package layout conventions.

## High-Level Technical Design

> *This illustrates the intended shape and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Registry file shape** (user-editable surface — paseo-compatible):

```
~/.claxedo/config.json
{
  "version": 1,
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"]
      },
      "claude-personal": {
        "extends": "acp",
        "label": "Claude (Personal)",
        "command": ["claude-agent-acp"],
        "env": { "ANTHROPIC_API_KEY": "sk-ant-personal-..." }
      },
      "codex-acp": { "enabled": false }
    }
  }
}
```

**Loader resolution pipeline:**

```
on gateway boot:
  raw = readFile("~/.claxedo/config.json")  // {} if missing
  user = ProviderFileSchema.parse(raw)
  defaults = builtInRegistry()              // 5 hardcoded entries
  merged = mergeByProviderId(defaults, user)
    where user entry wins by id; partial user entry shallow-merges into builtin
  resolved = merged
    .filter(e => e.enabled !== false)
    .sort((a,b) => (a.order ?? 100) - (b.order ?? 100))
  cache in-memory for process lifetime
```

**Adapter dispatch** (two factories + caller branching; replaces three inline dispatch copies):

```
// Caller (agent-session.ts-style):
pickAdapter(provider: ResolvedProvider, ctx):
  if provider._harnessMode == "central":
    return createCentralAdapter(provider, ctx)        // needs sync, lives in claxedo-server
  return createLocalAdapter(provider, ctx)            // no sync, lives in workspace-runtime


// workspace-runtime/src/adapters/factory.ts
createLocalAdapter(provider, ctx) -> AgentAdapter:
  if provider.extends == "pi": throw InvariantError
  if provider.extends == "opencode":
    return new OpenCodeAdapter({ command?: provider.command, env: composedEnv(provider) })
  if provider.extends == "acp":
    binary = resolveBinary(provider.command)
    return new ACPAdapter({
      binary,
      env: composedEnv(provider),                     // literal env + resolved credential overlay
      providerId: provider.id,                        // for logging/telemetry only
      disallowedTools: provider.disallowedTools,
    })


// claxedo-server/src/providers/factory.ts
createCentralAdapter(provider, { workspace, sync }) -> AgentAdapter:
  if provider.extends != "pi": throw InvariantError   // v1 invariant
  return getHarnessHost(sync).createAdapter(workspace)


// composedEnv unifies literal env + credential-registry resolution:
composedEnv(provider, ctx):
  env = { ...provider.env }                           // literal user values first
  basename = pathBasename(provider.command[0])
  authKey = AUTH_ENV_VARS[basename]                   // e.g. ANTHROPIC_API_KEY
  if authKey and not env[authKey]:
    credId = provider.credentialRef ?? provider.authProvider ?? provider.id
    secret = ctx.resolveSecret(credId)                // narrow resolver from ctx; backed by credentials/registry.ts on the server side
    if secret: env[authKey] = secret
  modelKey = MODEL_ENV_VARS[basename]
  defaultModel = provider.models?.find(m => m.isDefault)?.id
  if modelKey and defaultModel and not env[modelKey]:
    env[modelKey] = defaultModel
  return env
```

**Session record shape transition:**

```
old:  { workspaceId, sessionId, config: { runner: {type, binary, model}, variant, agent } }
new:  { workspaceId, sessionId, providerId, modelId?, variant?, agent?, updatedAt }

on read (backward-compat parser):
  if row.config?.runner?.type: translate to { providerId: runner.type, modelId: runner.model }
  else if row.providerId: use as-is
  else: drop row (malformed)
```

**Switch-on-live-session = fork:**

```
PATCH /api/sessions/:id/provider  body: { providerId, modelId }
  oldSession = loadSession(id)
  newSession = createSession({ providerId, modelId, directory: oldSession.directory })
  archive(oldSession) or leave in place (see deferred q)
  return { newSessionId }
```

## Implementation Units

- [ ] **Unit 1: Registry schema, loader, and default built-ins**

**Goal:** Establish the Zod schema for provider entries, author the built-in default registry (all 5 providers), and wire a loader that reads `~/.claxedo/config.json`, validates, merges with defaults, and exposes a read-only resolved list to the rest of the server.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None (foundation unit).

**Files:**
- Create: `packages/claxedo-server/src/providers/schema.ts` — Zod schemas (`ProviderEntrySchema`, `ProviderFileSchema`, `ResolvedProvider`).
- Create: `packages/claxedo-server/src/providers/defaults.ts` — `builtInRegistry()` exporting the 5 baked-in entries with `_harnessMode`.
- Create: `packages/claxedo-server/src/providers/registry.ts` — `loadRegistry()`, `getProviders()`, `getProvider(id)`; caches resolved list at module scope.
- Create: `packages/claxedo-server/src/paths.ts` additions if needed — expose `providerConfigPath()` next to `dataDir()`.
- Test: `packages/claxedo-server/src/providers/registry.test.ts` (Vitest).

**Approach:**
- Derive TS types from Zod via `z.infer` per `packages/workspace-runtime/src/process/process.ts` precedent.
- User-facing `ProviderEntrySchema` fields: `extends: "opencode" | "pi" | "acp"`, `label`, `description?`, `command?: string[]`, `env?: Record<string, string>`, `models?: Array<{id, label, isDefault?, description?}>`, `disallowedTools?: string[]`, `enabled?: boolean` (default `true`), `order?: number`, `credentialRef?: string`, `authProvider?: string`. Use `.strict()` to reject unknown keys.
- Internal `ResolvedProvider` adds `_harnessMode: "workspace" | "central"` (stripped from user entries during merge; sourced only from built-in defaults).
- `credentialRef` and `authProvider` are both optional. Semantics: when `createLocalAdapter` composes spawn env, the resolution order is `provider.env[key]` (literal) → `resolveSecret(provider.credentialRef)` → `resolveSecret(provider.authProvider)` → `resolveSecret(provider.id)` — first non-empty wins. This keeps literal `env` values as a user escape hatch and lets profiles share credentials via `authProvider: "anthropic"`.
- Merge strategy: user wins by providerId (shallow merge over built-in); unknown keys in user entries reject via Zod `.strict()`.
- `loadRegistry()` is a pure function of file content + defaults; caller decides when to invoke. Module-level cache is populated explicitly at gateway boot by Unit 3.
- Invalid file shape = throw at boot (not silently fall back). Fail-fast per "Feature-gate before persisting" learning.
- Consult `packages/claxedo-server/src/credentials/registry.ts` for the existing `CredentialMetadata` shape — `authProvider` values must align with that table's `provider_id` vocabulary (`"anthropic"`, `"openai"`, `"cursor"`).

**Execution note:** Test-first. Start with a failing test for "missing file + defaults produces 5 providers"; let the loader grow from there.

**Patterns to follow:**
- Zod → TS inference pattern: `packages/workspace-runtime/src/process/process.ts`.
- File-backed JSON cache + `readJsonFile` helper style: `packages/claxedo-server/src/agent-config.ts:105-119`.
- Self-export for config modules per `AGENTS.md`.

**Test scenarios:**
- No file present → resolved list = 5 built-ins, sorted by default `order`.
- Valid user file with one new ACP entry → resolved list = 6 providers.
- User entry shares ID with built-in, partial fields → shallow merge (e.g., user overrides `label` only).
- User entry with `enabled: false` hides a built-in.
- Two user entries both with `extends: "acp"` and same `command` but different `env` → both appear (profiles).
- Two profiles both setting `authProvider: "anthropic"` and no literal `env` → both resolve to the same credential at spawn composition (verified by a unit test on `composedEnv`).
- Profile with literal `env.ANTHROPIC_API_KEY` and `authProvider: "anthropic"` → literal env wins.
- Profile with `credentialRef: "anthropic-work"` pointing at a credential that doesn't exist → log warning, leave env unset, adapter still constructs.
- User attempts to set `_harnessMode` on a user entry → Zod `.strict()` rejects.
- Invalid `extends` value → Zod rejects, loader throws.
- Unknown top-level field → Zod `.strict()` rejects.
- `order` ties → stable by id ordering.

**Verification:** All test scenarios pass. `getProviders()` returns a typed array; `getProvider("claude-acp")` returns the built-in when no user file present. `credentialRef` / `authProvider` round-trip through Zod without loss.

- [ ] **Unit 2: Two-factory dispatch + spawn-time credential resolution; delete duplicate dispatches and `_acpAuthKeys`**

**Goal:** Replace three inline adapter-dispatch sites with a clean two-factory model (`createLocalAdapter` for local adapters in workspace-runtime; `createCentralAdapter` for pi in claxedo-server). Caller branches on `_harnessMode`. Delete the wrong-tenant-leaking `_acpAuthKeys` module object; compose spawn env per-invocation from `provider.env` + credential-registry resolution. Re-key all remaining RunnerType-literal dispatch tables.

**Requirements:** R2, R3, R5.

**Dependencies:** Unit 1.

**Files:**
- Create: `packages/workspace-runtime/src/adapters/factory.ts` — `createLocalAdapter(provider, ctx)` for `extends: "opencode" | "acp"`. Throws on `"pi"`.
- Create: `packages/claxedo-server/src/providers/factory.ts` — `createCentralAdapter(provider, { workspace, sync })` — wraps `getHarnessHost(sync).createAdapter(workspace)`. Throws on non-pi.
- Create: `packages/claxedo-server/src/providers/binary-resolvers.ts` — move `cursorBinary()` and ACP binary resolver from `agent-config.ts:85-101` and the duplicate in `workspace/full.ts:30-42`. Single implementation.
- Create: `packages/workspace-runtime/src/adapters/env-composer.ts` — `composedEnv(provider)` helper (see High-Level Technical Design). Reads from `resolveSecret` exported by `packages/claxedo-server/src/credentials/registry.ts` via a narrow adapter interface passed in `ctx` (avoids workspace-runtime → claxedo-server import).
- Modify: `packages/workspace-runtime/src/adapters/acp.ts` — remove `_acpAuthKeys` (`:79`), `setAcpAuth` (`:82-91`), `adapter.setAuth` (`:744-751`). `ACPAdapter` constructor takes `{binary: string, env: Record<string,string>, providerId: string, disallowedTools?: string[], models?: ProviderModel[]}`. `spawnArgs()` detects cursor by `basename(binary) === "agent" || basename(binary) === "cursor-agent"` rather than by providerId.
- Modify: `packages/workspace-runtime/src/adapters/opencode.ts` — constructor accepts `{command?: string[], env?: Record<string,string>}`; falls back to hardcoded `spawn("opencode", ["serve", ...])` when `command` absent. Env composed via `composedEnv` (for future opencode-via-credentials if ever needed; today opencode uses no credentials).
- Modify: `packages/workspace-runtime/src/workspace/full.ts` — remove inline factory at `:91-99`; remove duplicate binary fallback at `:30-42`. Call `createLocalAdapter`. Keep the existing pi-throw (workspace-runtime never constructs pi).
- Modify: `packages/claxedo-server/src/local-agent-engine.ts:121-133` — remove inline factory; call `createLocalAdapter` (or `createCentralAdapter` when `_harnessMode === "central"`).
- Modify: `packages/claxedo-server/src/harness/pi-host.ts:11-17` — preserved; called from `createCentralAdapter`.
- Modify: `packages/claxedo-server/src/harness/pi-support.ts:5-9` — re-key `AUTH_MAP` from RunnerType to `authProvider`. New shape: iterate resolved providers, consume each `provider.authProvider` to populate Pi's `AuthStorage` slot.
- Modify: `packages/claxedo-server/src/credentials/sync.ts:20-24` — re-key the `acp` record from RunnerType to `authProvider`. Keep values (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`).
- Modify: `packages/claxedo-server/src/routes/opencode-compat.ts` — remove inline `validTypes` at `:77`, `VALID_RUNNERS` at `:600`, hardcoded runner-type branches at `:308, 311-313, 320`, and RunnerType-keyed records at `:660-662, 882-884`. Derive from `getProviders()` / `getProvider(id).extends === "acp"`.
- Modify: `packages/claxedo-server/src/runner-resolution.ts:18-33` — replace the five-literal switch in `parseRunner` with `getProvider(input.type) !== undefined`. (Rename of this file to `provider-resolution.ts` happens in Unit 4; scope the switch rewrite here so Unit 4 doesn't carry the old enum forward.)
- Test: `packages/workspace-runtime/src/adapters/factory.test.ts` — `createLocalAdapter` matrix + env composition.
- Test: `packages/claxedo-server/src/providers/factory.test.ts` — `createCentralAdapter` delegates to HarnessHost; throws on non-pi.
- Test: `packages/workspace-runtime/src/adapters/env-composer.test.ts` — literal env wins; credentialRef > authProvider > providerId precedence; missing credential leaves env unset; binary basename drives `AUTH_ENV_VARS` lookup.

**Approach:**
- `createLocalAdapter(provider, ctx)`: dispatch on `extends` (opencode/acp), construct adapter with composed env, no `SyncDB` dependency.
- `createCentralAdapter(provider, { workspace, sync })`: assert `extends === "pi"`; return `getHarnessHost(sync).createAdapter(workspace)`.
- Caller (`agent-session.ts:178`-equivalent) does `pickAdapter(provider, ctx)` — one-line branch on `_harnessMode`. This matches the existing topology instead of inverting it.
- `composedEnv` lives in workspace-runtime but `resolveSecret` lives in claxedo-server. Bridge via `ctx.resolveSecret?: (providerId: string) => string | undefined` passed at call site — workspace-runtime gets an opaque resolver, no import inversion.
- `MODEL_ENV_VARS` / `AUTH_ENV_VARS` stay keyed by binary basename (correct — they're about the binary's env contract). Moved into `env-composer.ts` alongside the resolver.
- Delete `_acpAuthKeys` and `setAcpAuth` entirely. No replacement module-level state. All auth flows through `composedEnv` at spawn time.
- `AUTH_MAP` in `pi-support.ts` rekeyed by `authProvider`, with a default mapping for built-ins preserved (a provider with `authProvider === undefined` doesn't populate Pi's slot).
- Characterization tests cover the three deleted dispatch sites AND the pre-existing `_acpAuthKeys` cross-profile behavior (today's single-slot), so the replacement is demonstrably not a regression for the built-in case.

**Execution note:** Characterization-first. Before deleting any dispatch site or `_acpAuthKeys`, capture current behavior: (a) workspace/full → OpenCodeAdapter, (b) local-agent-engine → ACPAdapter with `claude-agent-acp`, (c) pi-host → PiAdapter, (d) built-in `claude-acp` spawn contains `ANTHROPIC_API_KEY` from `_acpAuthKeys.anthropic`. Then refactor; keep characterization green.

**Patterns to follow:**
- `AgentAdapter` contract: `adapters/index.ts:74-122` (unchanged).
- Idle-timeout pattern: `adapters/opencode.ts:34-37`, `adapters/acp.ts:93-96`.
- Credential registry read path: existing consumers at `packages/claxedo-server/src/harness/pi-support.ts:3, 42-68` and `packages/claxedo-server/src/routes/opencode-compat.ts:311-313`.

**Test scenarios:**
- Built-in `claude-acp` (authProvider `"anthropic"`, no literal env), credential registry has anthropic key → spawn env contains `ANTHROPIC_API_KEY`.
- Profile `claude-work` with literal `env.ANTHROPIC_API_KEY: "work-key"` → that literal wins over any credential-registry value.
- Profile `claude-personal` with `authProvider: "anthropic"` but NO literal env → resolves to credential-registry anthropic key. Verify `claude-work` and `claude-personal` resolve to the SAME key when they share `authProvider` — AND that the wrong-tenant bug from `_acpAuthKeys` is gone (profile `foo` with different credentialRef gets different key, not the last-pushed one).
- Profile with `credentialRef: "anthropic-work"` (explicit) → resolveSecret called with `"anthropic-work"`, not the providerId.
- Profile with only `providerId` (no credentialRef, no authProvider) → resolveSecret falls back to providerId; if undefined, env omits the key.
- `extends: "pi"` passed to `createLocalAdapter` → throws InvariantError.
- `extends: "opencode"` passed to `createCentralAdapter` → throws InvariantError.
- Cursor binary (`basename === "agent"`) → `spawnArgs()` returns `["acp"]`; all other binaries return `[]`.
- Pi's `AUTH_MAP` rekeying: a resolved provider with `authProvider: "anthropic"` populates `AuthStorage.anthropic`; a provider without `authProvider` does not.
- `opencode-compat.ts:600` `VALID_RUNNERS` replaced: request with any resolved providerId passes; with unresolved id → 4xx.
- `runner-resolution.ts:parseRunner` accepts any resolved providerId including user-added ones.

**Verification:** Characterization tests still pass. All banned string literals (`"claude-acp"` / `"codex-acp"` / `"cursor-acp"` / `"opencode"` / `"pi"`) appear only inside the default registry entries file (Unit 7) and documentation — not in dispatch code. No `_acpAuthKeys`, no `setAcpAuth`. Per-profile credential isolation demonstrated by test.

- [ ] **Unit 3: Backend routes — add `/api/claxedo/providers`, remove legacy config endpoints**

**Goal:** Expose the registry via two new endpoints and delete the four old endpoints that wrote to the three legacy stores.

**Requirements:** R1, R4.

**Dependencies:** Unit 1.

**Files:**
- Create: `packages/claxedo-server/src/routes/providers.ts` — `GET /api/claxedo/providers`, `GET /api/claxedo/providers/:id/probe`.
- Modify: `packages/claxedo-server/src/routes/agent-config.ts` — remove `POST /runner` (:231-286), `POST /runner/model` (:288-329), `POST /harness` (:127-162), `GET /runner/options` (:331-397). Keep `GET /runner` but rewrite to return `{providerId, modelId}` from session resolution. Keep `GET /harness` (read-only, derives from default provider's `_harnessMode`). Keep MCP + commands endpoints untouched.
- Modify: `packages/claxedo-server/src/server.ts` (or wherever routes are mounted) — register `providers.ts` routes.
- Modify: gateway boot sequence — call `loadRegistry()` before route registration; fail boot on invalid file.
- Test: `packages/claxedo-server/src/routes/providers.test.ts`.

**Approach:**
- `GET /api/claxedo/providers` returns `{providers: Array<{id, label, description?, extends, models?, availability, order}>}`. Strips `command`, `env`, `_harnessMode` — these are server-only.
- `GET /api/claxedo/providers/:id/probe` returns `{id, status: "ready" | "not-installed" | "missing-auth" | "error", detail?: string, models?: ...}`. Lazy — first call spawns the probe; subsequent calls within 30s return cached result.
- `GET /api/claxedo/agent-config/runner` rewritten: no more `runner/options`; model options are part of the provider response.
- No new write endpoints for the registry. The file is user-edited.

**Execution note:** Implement new endpoints test-first with real gateway + real `tmpdir()` config files; no HTTP mocks.

**Patterns to follow:**
- Hono route composition in `packages/claxedo-server/src/routes/*.ts`.
- Real-binary probe pattern: `real-acp-boot.integration.test.ts`.

**Test scenarios:**
- `GET /providers` with no config file → 5 built-ins returned.
- `GET /providers` with user file adding Gemini → 6 providers, Gemini's fields (minus `command`/`env`) present.
- `GET /providers/:id/probe` for a missing binary → `status: "not-installed"`.
- `GET /providers/:id/probe` for a present binary with missing env → `status: "missing-auth"`.
- `POST` to any of the four removed endpoints → 404.
- Gateway refuses to boot when `config.json` has `extends: "nonsense"`.

**Verification:** New endpoints return expected shapes. Deleted endpoints 404. CI grep confirms no production code references the deleted handlers.

- [ ] **Unit 4: Session record shape + provider-resolution; unlock switch**

**Goal:** Session records store `{providerId, modelId}` inline. Session-runners.json rows use new shape; backward-compat parser handles old rows on read. Lift the `sessionLocked` constraint. Swap endpoint forks a new session under the new provider.

**Requirements:** R5, R6, R7, R8.

**Dependencies:** Units 1, 2.

**Files:**
- Create: `packages/claxedo-server/src/paths.ts` (modify) — add `writeJsonAtomic(filepath: string, data: unknown, mode?: number)` helper. Writes to `<filepath>.tmp.<pid>.<random>`, calls `fsync`, `rename`. Error path cleans up tmp file.
- Modify: `packages/claxedo-server/src/session-runner.ts` — rename to `session-provider.ts`; row shape `{workspaceId, sessionId, providerId, modelId?, variant?, agent?, updatedAt}`; backward-compat parser for old `{config: {runner: {type, binary, model}}}` rows; writes via `writeJsonAtomic`; reads/writes wrapped in `Flock` around `dataDir()/agent-core/session-runners.lock` using `packages/shared/src/util/flock.ts`.
- Modify: `packages/claxedo-server/src/agent-config.ts:121-125` — `saveUserConfig` switches to `writeJsonAtomic`; wrapped in Flock around `dataDir()/user-agent-config.lock`. Fixes the pre-existing non-atomic write bug.
- Modify: `packages/claxedo-server/src/runner-resolution.ts` — rename to `provider-resolution.ts`; signature `resolveProviderForRequest(...): ResolvedProvider`; precedence `session → request → user → default` (preserved).
- Modify: `packages/claxedo-server/src/routes/agent-config.ts:262-266` — remove 409 "cannot change runner after session create".
- Modify: `packages/claxedo-server/src/local-agent-engine.ts:256-260` — remove equivalent guard.
- Add: `PATCH /api/claxedo/sessions/:id/provider` endpoint (in `routes/session.ts` or equivalent) — forks a new session under the new provider.
- Modify: session creation endpoint to accept `{providerId, modelId}` instead of `{runner: {type, model}}`.
- Modify: All 6 callers of `getSessionRunner` / `setSessionRunner` / `normalize` / etc. (paths from research: `routes/agent-config.ts:185,256,302`, `routes/opencode-compat.ts:609`).
- Test: `packages/claxedo-server/src/providers/session-provider.test.ts`; update `session-runner.test.ts` to use new API. Add test: two concurrent `setSessionConfig` calls against the same lock file serialize (use `Flock` test fixture at `packages/shared/src/util/test/fixture/flock-worker.ts`).
- Test: `packages/claxedo-server/src/paths.test.ts` — `writeJsonAtomic` rename semantics + tmp-cleanup on error.

**Approach:**
- `session-runners.json` file path unchanged (`dataDir()/agent-core/session-runners.json`). Only the row shape inside changes.
- Backward-compat parser invoked at first `load()`: detects legacy shape via presence of `config.runner`, transforms row-by-row to new shape, writes back **atomically**. After a successful transform + atomic rename, subsequent loads see new shape natively. Crash mid-transform leaves the original file intact; the tmp file is cleaned on next boot via a `*.tmp.*` sweep in `writeJsonAtomic`.
- If a legacy row's `runner.type` is not a resolved providerId (e.g., user disabled the built-in), log a warning and drop the session's provider binding; session resolves to default provider at next use.
- `writeJsonAtomic` + `Flock` both apply to `user-agent-config.json` as well — the existing `saveUserConfig` has no atomicity today (verified: plain `fs.promises.writeFile` at `:121-125`) and no lock; the refactor fixes this en passant because leaving a non-atomic writer adjacent to an atomic one is exactly the drift the "clean cutover" learning warns against.
- Switch = fork: `PATCH /sessions/:id/provider` → creates a new session via `adapter.createSession()`, copies title/metadata, returns `{newSessionId}`. Old session left in place (archival is follow-up work per deferred q).

**Execution note:** Characterization-first. Before touching the 409 guards, capture their current behavior in a test (POST runner change on existing session → 409). Then lift the guard and assert the new fork behavior.

**Patterns to follow:**
- Current `session-runner.ts:67-78` (normalize + save); the backward-compat parser lives in the same file.
- Session-split storage (metadata SQLite + config JSON) — continues to live in two places; the config JSON is what changes.
- Action-layer guard before navigation (per cloud-new-session-bootstrap-regression learning) — apply to session-create path if provider resolution is async.

**Test scenarios:**
- Load legacy session-runners.json → rows transform to new shape; file rewritten; subsequent loads are native.
- Session created with `{providerId: "claude-acp", modelId: "claude-sonnet-4-6"}` → persisted inline; resolution returns the same provider.
- Session with legacy `runner: {type: "claude-acp", model: "x"}` → resolves to `claude-acp` provider + model `"x"`.
- Session with legacy `runner.type: "gemini-acp"` (user has disabled it) → logs warning, resolves to default provider.
- `PATCH /sessions/:id/provider` on existing session with 10 messages → new session created under new provider; old session still retrievable.
- POST runner change endpoint (removed) returns 404; PATCH provider on same session no longer 409s.

**Verification:** All scenarios pass. Grep confirms `config.runner` is not written by any production path. Existing sessions with legacy shape continue resolving after a single boot.

- [ ] **Unit 5: Frontend selector rewrite; delete localStorage keys**

**Goal:** `agent-runner-selector.tsx` fetches providers from the server; no localStorage source-of-truth; no `sessionLocked`. Profiles render as distinct rows. Switch action calls `PATCH /sessions/:id/provider` and navigates to the new session.

**Requirements:** R3, R5, R6.

**Dependencies:** Units 3, 4.

**Files:**
- Rewrite: `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx` — fetch via `GET /api/claxedo/providers`; render list; on select → call `PATCH` (if live session) or set creation intent.
- Rewrite: `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts` — strip the 6 localStorage keys; rename the file to `providers-context.ts`; context exposes `providers()`, `selectProvider()`, `currentProviderId()`, `models()`, `selectModel()`. Remove `pickRunner`, `RunnerType`, `ACP_DISPLAY_NAMES`.
- Modify: `packages/claxedo-app/src/overrides/components/prompt-input/submit.ts` — update submission path to use new context shape.
- Modify: callers of `acp.setRunner`, `acp.setModel` (grep for references) — swap to `selectProvider`, `selectModel`.
- Test: `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.vitest.tsx` (rewrite with fixture provider list).
- Test: `packages/claxedo-app/src/claxedo-ui/context/providers-context.test.ts`.

**Approach:**
- Context loads providers once on mount; stays fresh for the process (no re-fetch unless user forces via a future refresh button).
- Selection state is per-session or per-draft, held in SolidJS store in-memory only. Not persisted. Server resolves default per request.
- Profile grouping: flat list sorted by `order` for v1. Label + description carry distinguishing info.
- No `sessionLocked` prop. Selector is always enabled unless `isPolling()` (transient loading state).
- On switch during live session: show a confirm dialog ("Switching providers will start a new session"), then PATCH and navigate.

**Execution note:** Test-first for the context rewrite. Use `bun run test` (not `bun test`) to ensure SolidJS reactivity is exercised.

**Patterns to follow:**
- `createSimpleContext` with `ready` gate — existing pattern in memory.
- `ModelSelectorPopover` from `@/components/dialog-select-model`.
- `on(ready, ...)` effect pattern to avoid tracking store properties.

**Test scenarios:**
- Fresh app load → `providers()` populated from server → selector renders 5 default labels.
- Provider list includes two `extends: "acp"` entries with same `command` but different `env` → both render as distinct rows with distinct labels.
- User selects a provider on a new draft → creation uses that provider.
- User selects a provider on live session with messages → confirm dialog → PATCH → navigates to new session.
- Server returns `availability: "not-installed"` for a provider → rendered disabled with "Unavailable" chip.
- No localStorage write during any of the above scenarios (asserted via `window.localStorage.setItem` spy or deletion-check assertion).

**Verification:** All scenarios pass. Grep confirms no readers or writers of the 6 deleted keys.

- [ ] **Unit 6: Legacy deletion + CI grep check**

**Goal:** Physically delete the duplicated unions, inline `validTypes` arrays, legacy localStorage helpers, and the `runner` field paths in `user-agent-config.json`. Add a PR-gating workflow that runs a grep check preventing regression.

**Requirements:** S4.

**Dependencies:** Units 2, 3, 4, 5 (all call sites migrated).

**Files:**
- Modify: `packages/claxedo-server/src/agent-config.ts` — delete `RunnerType` + `AcpRunnerType` exports at :76-77; delete `defaultRunner()`; `acpBinary()`, `cursorBinary()` already moved in Unit 2 (just remove the dangling imports here); delete `runner` field and `harness.mode` sub-field from `UserAgentConfigSchema`; keep MCP/auth/sandbox sections.
- Modify: `packages/workspace-runtime/src/adapters/index.ts:54-58` — delete `SessionRunner` union; replace with `ResolvedProvider` (sourced via a narrow type import or a small shared types surface — decide during implementation).
- Modify: `packages/workspace-runtime/src/routes/config.ts:6-10` — delete `RuntimeRunner` union; schema uses `providerId`.
- Delete: `packages/claxedo-server/src/runner-resolution.ts` (now `provider-resolution.ts` per Unit 4; the old file is gone).
- Modify: `packages/claxedo-server/src/architecture.ts:29-37` — `getHarnessMode()` reads env `CLAXEDO_HARNESS_MODE` first (preserved), then `_harnessMode` on the default provider (from the registry). The `cfg.harness?.mode` branch is removed. `configureHarnessMode` still mutates the env var (no change there).
- Verify (already deleted by Unit 5): `ACP_DISPLAY_NAMES`, `pickRunner`, the 6 localStorage constants. Unit 6 adds grep coverage to prevent re-introduction.
- Verify (already handled by Unit 2): `opencode-compat.ts:77,600,660-662,882-884`, `runner-resolution.ts:18-33`, `credentials/sync.ts:20-24`, `_acpAuthKeys`, `setAcpAuth`. Unit 6's grep check enforces deletion, but the code changes happened upstream.
- Create: `script/check-legacy-paths.ts` — grep-based check; fails CI on presence of banned strings.
- Create: `.github/workflows/lint.yml` — PR-gating workflow running `npm run typecheck`, `oxlint`, and the legacy-paths check.
- Modify: root `package.json` — add `"check:legacy": "bun script/check-legacy-paths.ts"` and include in the `turbo` pipeline.

**Approach:**
- Banned strings (any occurrence in `packages/**/src/**/*.{ts,tsx}` fails, outside allow-list):
  - LocalStorage keys: `"claxedo:runner-map"`, `"claxedo:acp-model-map"`, `"claxedo:agent-mode-map"`, `"claxedo:runner"`, `"claxedo:acp-model"`, `"claxedo:agent-mode"` (exact string literal match)
  - Type identifiers: `AcpRunnerType`, `RunnerType`, `SessionRunner.type`, `RuntimeRunner.type` (regex match)
  - Removed helpers: `_acpAuthKeys`, `setAcpAuth`, `defaultRunner(`, `acpBinary(`, `cursorBinary(` (any call from outside `providers/binary-resolvers.ts`)
  - Legacy-shape session-runners field in code: `"\.runner\.type"`, `"\.runner\.binary"` (regex; the backward-compat parser in `session-provider.ts` is allow-listed by file path)
  - `user-agent-config.json` combined with `runner` on the same line (regex) — catches any read/write of the removed field
  - Harness sub-field: `"cfg\.harness"`, `"harness\.mode"` outside `architecture.ts` and tests (regex) — `CLAXEDO_HARNESS_MODE` env string is explicitly NOT banned (it stays).
- Allow-list entries for legitimate still-mentions: the default registry file (Unit 7 uses the providerId string literals), the backward-compat parser comment, and docs under `docs/`.
- The grep check is written so running it locally after each of Units 2-5 catches forgotten references early.

**Execution note:** Run the grep check locally after each of Units 2-5 to catch forgotten references early; wire it as a unit-level verification step, not only the final unit.

**Patterns to follow:**
- `script/` top-level exists (`web-dev-local.ts`); drop the new check script alongside.
- `.github/workflows/release-claxedo.yml` for workflow composition precedent.

**Test scenarios:**
- `check-legacy-paths.ts` on HEAD before Unit 6 changes → fails with a list of violations.
- `check-legacy-paths.ts` after Unit 6 changes → passes.
- Adding `"claxedo:runner-map"` back to any source file → fails with a line reference.
- Adding `AcpRunnerType` back anywhere → fails.
- CI workflow runs on PR open + push; fails the check on violations; passes with clean tree.

**Verification:** All banned strings absent from production code. CI enforces going forward. Existing tests pass.

- [ ] **Unit 7: Default built-in registry content + end-to-end integration tests**

**Goal:** Author the five baked-in default provider entries with exhaustive detail (commands, env, models, harness mode). Validate end-to-end via integration tests that spawn real binaries and stream real CompatEvents.

**Requirements:** R2, R8, S1, S2, S3.

**Dependencies:** Units 1-5 landed.

**Files:**
- Modify: `packages/claxedo-server/src/providers/defaults.ts` (from Unit 1) — flesh out the built-in entries.
- Create: `packages/claxedo-server/src/providers/defaults.integration.test.ts` — real-binary integration tests.
- Create: `packages/claxedo-server/src/providers/profiles.integration.test.ts` — two ACP entries sharing `extends: "acp"` with different `env`.
- Create: `packages/claxedo-server/src/providers/gemini-acp-addition.integration.test.ts` — fixture config adds Gemini entry; asserts session creation + CompatEvent streaming end-to-end (S1).

**Approach for each built-in:**

| providerId | extends | command | env | authProvider | models | _harnessMode |
|---|---|---|---|---|---|---|
| `opencode` | `opencode` | — (default spawn) | inherits `OPENCODE_CONFIG_DIR` | — | dynamic (from opencode probe) | `workspace` |
| `pi` | `pi` | — (HarnessHost-managed) | — | — (pi composes its own auth from all resolved providers' `authProvider` values) | dynamic (from `ModelRegistry.getAll()`) | `central` |
| `claude-acp` | `acp` | `[resolveAcpBinary("claude-agent-acp")]` | — | `"anthropic"` | dynamic probe | `workspace` |
| `codex-acp` | `acp` | `[resolveAcpBinary("codex-acp")]` | — | `"openai"` | dynamic probe | `workspace` |
| `cursor-acp` | `acp` | `[cursorBinary()]` | — | `"cursor"` | dynamic probe | `workspace` |

No built-in ships with literal `env` values — credential resolution happens at spawn time via `composedEnv` (Unit 2). `authProvider` on each ACP built-in points at the credential-registry `provider_id` that owns the API key (matches `CredentialMetadata.provider_id` values at `packages/claxedo-server/src/credentials/types.ts:11-26`). A user profile can override by setting its own literal `env` or its own `credentialRef`.

`resolveAcpBinary` and `cursorBinary` live in `packages/claxedo-server/src/providers/binary-resolvers.ts` (created in Unit 2). The default registry imports them to compute `command[0]` at registry-load time.

**Execution note:** Test-first where feasible (the fixture-based additions test), but the real-binary integration tests (opencode + ACPs) exercise upstream binaries that must already be installed — these tests rely on CI having the binaries available, as they do today for `real-acp-boot.integration.test.ts`.

**Patterns to follow:**
- Real-binary integration test: `packages/claxedo-server/src/real-acp-boot.integration.test.ts`.
- Multi-runner integration test: `packages/claxedo-server/src/multi-agent.integration.test.ts`.

**Test scenarios:**
- Fresh install (no `~/.claxedo/config.json`) → 5 default providers returned by `GET /providers`. (S3)
- Two entries extending `acp` with different `ANTHROPIC_API_KEY` values → both create sessions independently. (S2)
- Fixture config adds `{id: "gemini", extends: "acp", command: ["gemini", "--acp"]}` → `GET /providers` returns 6 providers; session creation with providerId `gemini` succeeds; CompatEvents stream. (S1)
- Existing session record with `runner.type: "claude-acp"` (persisted pre-migration) → resolves to built-in `claude-acp` provider after boot.
- Disable `codex-acp` via user config (`{codex-acp: {enabled: false}}`) → absent from `GET /providers`; existing sessions with codex-acp log warning and fall back to default.

**Verification:** Integration tests pass in CI. All five built-ins spawn real adapters when binaries available. S1-S3, S5 end-to-end demonstrated.

## System-Wide Impact

- **Interaction graph:**
  - Removed endpoints: `POST /api/claxedo/agent-config/runner`, `POST /runner/model`, `POST /harness`, `GET /runner/options`. Any external consumer (extensions, integration scripts) breaks with 404. Document in rollout notes.
  - Added endpoints: `GET /api/claxedo/providers`, `GET /api/claxedo/providers/:id/probe`, `PATCH /api/claxedo/sessions/:id/provider`.
  - Gateway boot sequence gains a `loadRegistry()` call before route registration; a malformed config throws at boot (fail-closed, not silent fallback).
- **Error propagation:**
  - Invalid registry file at boot → gateway process exits with descriptive message + path to the offending file. Desktop app surfaces the error in a toast before the window opens.
  - Unknown providerId on a persisted session → warning logged, session falls back to default provider at next access (does not crash).
  - Missing binary at probe → `status: "not-installed"` in `GET /providers/:id/probe`; UI renders "Unavailable" chip, selection blocked for that entry.
- **State lifecycle risks:**
  - Backward-compat parser in Unit 4 writes new shape on first load. If the gateway crashes mid-write, partial file could corrupt session-runners.json. Mitigate with atomic write (write to `*.tmp`, rename) matching existing `saveUserConfig` pattern.
  - Fork-on-switch creates a new session; the old session is not deleted. Over time, users accumulate "archived" sessions. Archival UX is deferred work; in v1 old sessions remain visible in session lists.
  - LocalStorage key deletion is one-way. Pre-v1 users visiting a v1 app see their saved runner preferences discarded. Document in release notes.
- **API surface parity:**
  - Any extension consuming the removed POST endpoints must migrate to registry + PATCH patterns. Search-and-communicate before release.
  - The `opencode-compat.ts` routes (:77, :600, :609) are a shim for upstream opencode tools; verify those tools still call only `GET /runner` (or whatever endpoint they need post-rewrite).
- **Integration coverage:**
  - Cross-layer scenarios unit tests alone don't prove: end-to-end session creation with a non-default provider, end-to-end PATCH-switch-on-live-session (covered by Unit 4 + Unit 7 integration tests).
  - Gateway restart behavior: after editing `~/.claxedo/config.json`, a restart must surface the new list. Manual smoke test as release checklist item.

## Risks & Dependencies

- **Risk: Credential-centralization is partially-but-not-fully landed.** The infrastructure (`credentials/{types,store,registry,sync}.ts`, `resolveSecret`, `CredentialMetadata`) has shipped; the dedicated `routes/credential.ts` surface, full network-policy enforcement, and UI status semantics remain aspirational. **Mitigation:** `authProvider` values in the default registry must match the existing `CredentialMetadata.provider_id` vocabulary (`"anthropic"`, `"openai"`, `"cursor"`). If the credential plan's later phases change that vocabulary, the built-in registry entries update in step — a single constants file, not a cross-cutting refactor.
- **Risk: Two factories + caller dispatch introduces a new indirection the caller must handle correctly.** If a caller forgets to branch on `_harnessMode` and passes pi to `createLocalAdapter`, we get an InvariantError at runtime. **Mitigation:** Invariant throws with a pointer to the caller site; integration test covers the branching in `agent-session.ts`; grep check (Unit 6) forbids direct calls to `new PiAdapter` outside `createCentralAdapter` / `harness/pi-host.ts`.
- **Risk: Per-spawn credential composition changes the timing of `resolveSecret` calls.** Today auth is pushed once at startup via `setAcpAuth`; post-Unit 2, each adapter spawn calls `resolveSecret`. **Mitigation:** `resolveSecret` is already called per-request in `opencode-compat.ts:311-313` — not a new access pattern. If latency becomes a concern (unlikely at session-creation cadence), add a short TTL cache inside `composedEnv`.
- **Risk: Multi-process access to `~/.claxedo/`.** Desktop + headless gateway (or two claxedo-server instances for parallel dev) could both write `session-runners.json` or `user-agent-config.json`. **Mitigation:** `writeJsonAtomic` + `Flock` around both files (Unit 4). Without this, the backward-compat-read-then-rewrite in Unit 4 is a race that can drop rows from the other writer.
- **Risk: `saveUserConfig` is being modified in a refactor PR, not a dedicated bugfix PR.** Changing an existing writer's atomicity could surface latent bugs in any caller that relied on partial-write visibility (unlikely, but possible). **Mitigation:** Sequence Unit 4 so the `writeJsonAtomic` helper lands with tests before the `saveUserConfig` rewrite; any latent caller breaks loudly in existing tests.
- **Risk: Session-runners.json backward-compat parser drops rows on shape mismatch.** Loss of session-provider binding. **Mitigation:** Log at `warn` level before dropping; keep raw row under a `.bak` sidecar for 7 days.
- **Risk: No PR-gating CI exists today.** Adding `lint.yml` is a net-new workflow. **Mitigation:** Land the workflow behind an explicit initial run to validate, then enable as required check.
- **Risk: User-authored custom ACPs with arbitrary `command` arrays introduce spawn-security concerns.** The config file is user-owned local state, not remote input, but we should not execute `command` with shell interpolation. **Mitigation:** Spawn with `{shell: false}`, pass args array directly.
- **Dependency: `oxlint` / `bun turbo typecheck` in CI.** Workflow depends on existing lint/typecheck targets.
- **Dependency: Vitest + bun test mixed frameworks** per package. Tests use the package's own runner; no cross-package test harness changes.
- **Dependency: `packages/shared/src/util/flock.ts` primitive.** Used unchanged for file locking; has existing tests and fixtures.
- **Dependency: `packages/claxedo-server/src/credentials/registry.ts`** exports `resolveSecret` and `getCredentialByProvider`. The `createLocalAdapter` ctx receives a narrow resolver interface so workspace-runtime doesn't import claxedo-server directly.
- **Dependency: `~/.claxedo/agent-core/` directory exists** — already created by existing code path; new code reuses.

## Alternative Approaches Considered

- **Dual-read transitional layer (fallback to old stores if new config absent).** Rejected: origin doc explicitly chose clean break; learnings (multi-backend migration, agent-hooks consolidation) both established that dual-read shims cause more bugs than they prevent.
- **Keep three stores but add a schema-enforced facade.** Rejected: does not satisfy "app reads, never writes" (R4) and leaves the source-of-truth question open.
- **TOML file format with comment support.** Rejected: adds a parser dependency, diverges from paseo vocabulary (cross-ecosystem copy-paste lost), zero precedent in claxedo. JSONC as a future add-on is cheap.
- **Split built-ins into their own non-file registry and keep the user config file for custom providers only.** Rejected: users can't disable built-ins or override labels without editing code; defeats the "user wins by ID" model that makes profiles work.
- **Ship port allocator + name-based proxy now (paseo v1 parity).** Rejected per origin doc scope boundaries. Captured for future work.
- **Surface `runsOn` in user schema as an explicit (but v1-read-only) field.** Rejected: if it's not actionable in v1, naming it now locks the word before we've seen how users want to control it. Defer until actionable.
- **Single unified adapter factory (originally proposed in this plan's v1 draft).** Rejected on deepen-pass: pi requires `SyncDB` from claxedo-server; a factory in `workspace-runtime` that handles pi would force a layering inversion. Two factories + caller dispatch matches today's topology and keeps each package's dependency direction clean.
- **Generalize `_harnessMode: "central"` to user-declared providers (pluggable HarnessHost registry).** Rejected: pi is the only central provider today; a pluggable registry is YAGNI until a second central implementation exists. Document the pi-specificity explicitly so future contributors don't assume generality.
- **Leave `_acpAuthKeys` in place for v1 and fix it in a follow-up PR.** Rejected: the wrong-tenant-leakage bug (`claude-work` inherits `claude-acp`'s key) materializes the moment profiles ship, and profiles are R3. Fixing it in the same PR that introduces profiles is the honest move.
- **Skip the atomic-write fix for `saveUserConfig` (leave pre-existing bug for a separate PR).** Rejected: introducing an atomic `writeJsonAtomic` helper alongside a non-atomic existing writer is exactly the kind of drift the "clean cutover" learning warns against. One PR, one invariant.

## Dependencies / Prerequisites

- **Before Unit 1 starts:** Confirm the `CredentialMetadata.provider_id` vocabulary in `packages/claxedo-server/src/credentials/types.ts:11-26` (values: `"anthropic"` / `"openai"` / `"cursor"`). `authProvider` values in the built-in registry must match. Verified by research on 2026-04-22; re-check at Unit 1 start in case it shifted.
- **Before Unit 2 starts:** Confirm `packages/shared/src/util/flock.ts` is stable and its test fixtures (`packages/shared/src/util/test/fixture/flock-worker.ts`) are usable by claxedo-server tests.
- **Before Unit 6 starts:** All callers of the deleted types/constants migrated by Units 2-5. Grep check would otherwise fail preemptively.
- **Before Unit 7 integration tests run:** CI image has `claude-agent-acp`, `codex-acp`, `agent`/`cursor-agent` binaries installed (as it does today for `real-acp-boot.integration.test.ts`).
- **No external service dependencies.** Fully local.

## Phased Delivery

**Phase 1 — Foundation (Units 1, 2):** Registry schema + loader, unified factory. No behavior change observable to users; internal refactor. Lands first so Phase 2 can build on a stable factory.

**Phase 2 — Contract migration (Units 3, 4):** New API endpoints + session record shape. Backward-compat parser preserves existing sessions. Behavior changes become observable (new URLs, removed URLs). This is the risky commit; stage behind a feature-flag env (`CLAXEDO_REGISTRY_V1`) for one release cycle if the team wants a safety hatch — otherwise land directly given the clean-break posture.

**Phase 3 — Frontend (Unit 5):** Selector rewrite. User-facing UX changes visible. Ship after Phase 2 has baked for ≥1 day of local testing.

**Phase 4 — Cleanup (Units 6, 7):** Delete legacy code, add CI gate, author exhaustive built-in defaults + integration tests. Lands last so grep check doesn't trigger spurious failures during Phases 1-3.

Each phase is a separate PR. Total: 4 PRs.

## Documentation / Operational Notes

- **User-facing release note:** "Runner selection has moved to a single config file at `~/.claxedo/config.json`. Custom tweaks to `user-agent-config.json` (`runner` field) and `session-runners.json` are reset; defaults cover all previously-available runners. To add a new ACP, see [link]."
- **New doc:** `docs/providers.md` — mirrors paseo's CUSTOM-PROVIDERS.md, claxedo-flavored. Example configs for Gemini, Hermes, Z.AI-via-claude. Called out from AGENTS.md.
- **Monitoring:** No metrics today. If/when added, track `provider.probe.status` distribution and `session.provider.switch.rate`.
- **Rollback:** If Phase 2 breaks in the field, revert the PR. The backward-compat parser does not destructively rewrite the old file until after successful load, so a revert leaves the legacy file intact for re-read.
- **Desktop packaging:** `CLAXEDO_ACP_DIR` env remains valid for bundled binaries. Default registry reads it when resolving `command[0]`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-22-agent-runner-registry-requirements.md](../brainstorms/2026-04-22-agent-runner-registry-requirements.md)
- Related plan (coordinate): [docs/plans/2026-04-10-credential-centralization-and-broker-plan.md](2026-04-10-credential-centralization-and-broker-plan.md)
- Related plan (pattern source): [docs/plans/2026-04-09-workspace-runtime-type-refactor-plan.md](2026-04-09-workspace-runtime-type-refactor-plan.md) — Zod + codec pattern
- Related plan (learnings): [docs/plans/2026-04-10-agent-hooks-consolidation-plan.md](2026-04-10-agent-hooks-consolidation-plan.md) — no compat shims when collapsing writers
- Related migration: [docs/multi-backend-migration.md](../multi-backend-migration.md), [docs/multi-backend-migration-implementation.md](../multi-backend-migration-implementation.md) — identifier-lock, clean-cutover
- Related bug-report: [docs/bug-reports/2026-04-13-cloud-new-session-bootstrap-regression.md](../bug-reports/2026-04-13-cloud-new-session-bootstrap-regression.md) — action-layer guards
- External reference: [Paseo Custom Provider Configuration](https://github.com/getpaseo/paseo/blob/main/docs/CUSTOM-PROVIDERS.md)
- Key code anchors:
  - Runner union sources: `packages/claxedo-server/src/agent-config.ts:76-77`, `packages/workspace-runtime/src/adapters/index.ts:54-58`, `packages/workspace-runtime/src/routes/config.ts:6-10`, `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:7`
  - Adapter dispatch sites: `packages/workspace-runtime/src/workspace/full.ts:91-99`, `packages/claxedo-server/src/local-agent-engine.ts:121-133`, `packages/claxedo-server/src/harness/pi-host.ts:11-17`
  - AgentAdapter contract (frozen): `packages/workspace-runtime/src/adapters/index.ts:74-122`
  - Session-runners storage: `packages/claxedo-server/src/session-runner.ts:18-137`
  - Selector UI: `packages/claxedo-app/src/claxedo-ui/components/agent-runner-selector.tsx:12-204`
  - Frontend localStorage keys: `packages/claxedo-app/src/claxedo-ui/context/acp-config.ts:21-26`
  - Route handlers to delete: `packages/claxedo-server/src/routes/agent-config.ts:120-397`
