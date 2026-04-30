---
date: 2026-04-22
topic: agent-runner-registry
---

# Agent Runner Registry

## Problem Frame

Claxedo today wires three agent-runner paths (opencode-server, ACP client, pi brain/hand) as parallel code paths. The "which runner" decision is duplicated across three stores: frontend localStorage (`claxedo:runner-map`, `claxedo:acp-model-map`), backend `user-agent-config.json`, and backend `session-runners.json`. Adding a new ACP client requires edits to five files. Runner selection is treated as immutable create-time session state, which is state-coupling dressed up as a product constraint.

The `AgentAdapter` → `CompatEvent` translation layer is the one clean piece and is preserved as-is.

Paseo (paseo.sh / getpaseo/paseo) already solved the declarative-registry-plus-runtime-selection problem for this exact shape of app. V1 mirrors paseo's core moves — single declarative config, app reads never writes, built-ins and custom ACPs in one schema, first-class profiles — and explicitly defers its ambitious pieces (CLI, port allocator, name-based proxy, cross-host `runsOn`).

## Requirements

- **R1.** A single declarative config file at `~/.claxedo/config.json` is the authoritative source of truth for the available agent providers. The app reads it; the app never writes to it.
- **R2.** Built-in providers (`opencode`, `pi`, `claude-acp`, `codex-acp`, `cursor-acp`) are expressed as entries in the default-shipped registry. Users can hide built-ins with `enabled: false`. Users can add arbitrary ACP providers by adding an entry that declares an ACP-shaped extension plus a command to spawn. Adding a provider requires zero code changes.
- **R3.** Profiles — multiple entries that extend the same built-in with different credentials/models (e.g., `claude-work` and `claude-personal`, or `claude-fast` pinned to Sonnet vs `claude-smart` pinned to Opus) — are first-class. Each profile appears as a distinct selectable provider in the UI.
- **R4.** The list of providers is immutable during a given app/gateway process lifetime. Editing the config file takes effect on next restart. There is no in-app UI that writes or mutates the file, no file-watcher, no hot reload.
- **R5.** Runner selection is per-session runtime state, not create-time immutable state. The current constraint that refuses a runner change on an existing session is lifted at the UI/API layer. (What happens to conversation state when a switch occurs — fork a new session, or continue with best-effort handoff — is a planning question, not a product requirement.)
- **R6.** Frontend localStorage does not mirror the registry or the current selection as state-of-record. Existing keys (`claxedo:runner-map`, `claxedo:acp-model-map`, etc.) are removed. Ephemeral per-tab UI caches are allowed but are not authoritative.
- **R7.** Backend config split across `user-agent-config.json` and `session-runners.json` is collapsed. Session-level runner selection lives on the session record directly (a `{ providerId, modelId }` pair).
- **R8.** Existing session records that reference old runner IDs (`claude-acp`, `codex-acp`, `cursor-acp`, `opencode`, `pi`) continue resolving because the default-shipped registry preserves those exact IDs as built-ins.

## Success Criteria

- **S1. Zero-code extensibility.** Adding a new ACP (e.g., Gemini CLI) requires editing only `~/.claxedo/config.json`. The new provider appears in the runner selector on next app restart, and a session created with it produces CompatEvents end-to-end.
- **S2. Profiles work.** Two entries that both extend `claude` with different `ANTHROPIC_API_KEY` values result in two independently-selectable providers. Each opens sessions under its own credentials without collision.
- **S3. Fresh install has zero config.** Installing claxedo from scratch with no `~/.claxedo/config.json` works; defaults cover opencode, pi, and the three ACPs.
- **S4. Legacy paths deleted.** No runtime code path reads from `user-agent-config.json`, `session-runners.json`, or the old localStorage runner keys after v1 ships. Grep in CI can assert this.
- **S5. Switch-after-create works.** On an existing session, selecting a different available provider from the UI no longer errors. (Exact state-handoff behavior asserted by planning, not by this criterion.)

## Scope Boundaries

Explicitly **out of scope for v1**:

- CLI parity (`claxedo run --provider X` and friends). The scripting surface for v1 is the config file itself.
- Port allocator, per-workspace ephemeral port allocation, `*.localhost` name-based reverse proxy, `PASEO_SERVICE_*_URL`-style peer env injection. Gateway remains on hardcoded port 3000; sandbox-agent / opencode-server / pi port handling is unchanged.
- Explicit `runsOn` field on provider entries. Behavior is hardcoded per built-in (opencode → workspace sandbox, pi → central server brain, ACPs → gateway host).
- True hot-swap of conversation history across providers. Switching runner on a session may fork into a new session rather than continue the same conversation.
- Migration of user-customized content from `user-agent-config.json` or `session-runners.json`. Clean break: users re-apply any custom tweaks once.
- `CLAXEDO_HOME` env override for parallel instance isolation. Defer until there's a real parallel-dev use case.
- Rebuilding the `AgentAdapter` / `CompatEvent` layer. It stays.

## Key Decisions

- **Config file format = JSON.** Matches paseo, matches the existing `user-agent-config.json` / `session-runners.json` precedent, zero parser dependency. Comments can be added via JSONC if ever needed.
- **Config file location = `~/.claxedo/config.json`.** Parallels paseo's `~/.paseo/config.json`.
- **Schema shape borrows paseo's vocabulary.** `extends` (built-in ID or `"acp"`), `label`, `command`, `env`, `models`, `enabled`, `order`, `disallowedTools`. Exact final field names are a planning detail; the vocabulary is inherited.
- **List immutability = process-lifetime, restart to reload.** No file-watcher, no hot reload, no in-app editing UI. Makes config → runtime state strictly one-directional.
- **Clean break over dual-read.** Zero legacy read paths in the new runtime. Default registry ships preserving old IDs so known installations self-heal; installations that hand-edited the old JSON files re-configure once.
- **Profiles under the same schema as ACPs.** `extends: "claude"` with different `env` = a profile. No separate concept, no separate schema.
- **Switch-lock lift means "UI no longer refuses."** Conversation-state behavior under switch is delegated to planning.

## Dependencies / Assumptions

- `AgentAdapter` interface and `CompatEvent` translation stay stable. Providers continue to plug into the existing adapter surface; nothing downstream of event translation needs to change.
- Session record schema can carry `{ providerId, modelId }` directly on the row. No new storage layer needed.
- User base is small enough that a clean-break cliff is acceptable (origin repo is `kyashrathore/Claxedo`, a personal fork).
- Built-ins (`opencode`, `pi`) can be expressed in the same `{ extends, command, env, models }` shape as ACPs. Research during planning will confirm this holds for pi's brain/hand adapter.

## Outstanding Questions

### Resolve Before Planning

_(none — planning can proceed.)_

### Deferred to Planning

- **[Affects R5] [Technical]** When a user switches runner on an existing session, does the session fork (new record under the new provider, old session archived) or stay the same with a provider change where conversation continuation is best-effort per provider? Planning should pick one and document it.
- **[Affects R2] [Technical]** Exact JSON schema field names — adopt paseo's `extends`/`label`/`command`/`env`/`models`/`enabled`/`order`/`disallowedTools` verbatim, or adjust for claxedo naming conventions.
- **[Affects R1, R2] [Needs research]** Default registry contents for the `opencode` and `pi` built-ins. Specifically: what `command` / `env` / `models` each needs when expressed in this shape. Research starts in `packages/claxedo-server/src/agent-config.ts` and `packages/claxedo-server/src/harness/pi-adapter.ts`.
- **[Affects R8] [Needs research]** Whether any persisted session records use a runner field shape beyond a plain ID string (e.g., with baked-in env or model overrides). If so, migration to `{ providerId, modelId }` needs per-record handling, not just ID preservation.
- **[Affects R6] [Technical]** Which frontend selection state is still ephemeral-cache-fine (e.g., "last-used provider per workspace" as a convenience) vs. must be deleted (e.g., `claxedo:runner-map` as source of truth).
- **[Affects S4] [Technical]** CI grep check to enforce legacy-path deletion — wire it into the existing lint pipeline or a new pre-commit check.

## Next Steps

→ `/ce:plan` for structured implementation planning.
