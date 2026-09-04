---
title: "feat: Agent Plugins marketplace — Directory surface and Install flow"
date: 2026-09-04
status: planned (owner decisions recorded 2026-09-04; ready to execute)
branch: codex/refactor-agent-plugins
depends-on: 2026-09-04-001-feat-agent-plugins-d1-hosted-port-plan.md, 2026-09-04-002-feat-d1-sandbox-lease-store-plan.md
---

# feat: Agent Plugins marketplace — Directory surface and Install flow

## Why

The marketplace today is one component (`features/agent-plugins/catalog.tsx`, 410 lines) that renders every
candidate as a dense `<article>` with harness chips, a select for project targets, and inline connect buttons.
The owner's verdict on 2026-09-04: "ugly". The reference is the Cursor Customize surface: a searchable
directory of logo cards grouped by marketplace, a detail view per entry, marketplaces you add yourself from
GitHub, and a short install dialog that shows where a plugin lands and how it authenticates.

Two user-facing outcomes:

1. **Directory** — see what exists (Claxedo's collection, marketplaces you added from GitHub, and plugins other
   harnesses already installed on this machine), open one, and read its skills and MCP servers in a side panel.
2. **Install flow** — when enabling, see the environments (local / cloud), the projects, and the harnesses it
   will reach, and choose personal or enterprise authentication for its MCP servers.

## Current flow (observed)

- `A. workbench tab "marketplace"` → `A.1 CatalogSurface` (`app/composition/agent-plugin-contribution-loader.tsx`)
  picks `signed` vs `unsigned` from `account.state()` and hands `AgentPluginCatalog` an `AgentPluginApi`
  (`features/agent-plugins/api.ts`): `catalog`, `activation`, `organizationDefault`, `update`; signed desktop
  routes those through named account operations (`agent-plugin-account-api.ts`), and MCP connections through
  `createIntegrationsRequest` (`agent-plugin-connections.ts`).
- `A.2 AgentPluginCatalog` reads `GET /api/claxedo/plugins` (`PluginCatalog { revision, supportedHarnesses,
  projects?, candidates, errors, canManage* }`) and renders header → project targets (signed) → harness targets →
  one article per candidate with `Enable / Disable / Use default / Update / Enable for organization` and a
  per-MCP-server connection block.
- Server: `PluginCandidate` comes from `candidateView`/`retainedView` in `claxedo-server/src/agent-plugins/routes.ts`
  (signed) and `claxedo-local-server/src/agent-plugins/activation/routes.ts` (unsigned). A plugin is
  `AgentPluginManifest` (10 schema keys, unknown keys rejected) + `skills/<dir>/SKILL.md` + `.mcp.json`; there
  are no hooks, commands, or agents. The only source is the hard-wired public collection
  `kyashrathore/plugins@main` (`server-core/src/agent-plugins/sources/github-public.ts`).
- Activation has two dimensions, harness × project target (`all-projects` | `projects[]`, signed only); local vs
  cloud is a delivery fact (desktop pulls `GET /runtime/self`, VMs receive `POST /api/wr/agent-plugins/apply`),
  not an activation choice. Unsigned activation is machine-wide.
- Nothing reads what Claude Code, Cursor, or Codex have installed; the projection adapters only write their own
  marker-owned entries.
- There is no right-side inspector primitive. `features/workspaces/ui/panel/workspace-panel.tsx` is a
  workspace-scoped right panel; `ui/context-card` is a gutter card. The marketplace is a workbench tab
  (`ContentType "marketplace"`, id prefix `mkt`, route `/marketplace`).

## Design

Terms introduced (proposed): **Directory** = the browse surface; **Source** = a marketplace the catalog reads
(Claxedo collection, an added GitHub repository, a machine harness); **Install sheet** = the dialog shown on
Enable.

### D1. Catalog contract additions (server-core, both rails)

`PluginCandidate` gains presentation and reading fields, produced once in server-core and reused by both route
owners:

- `icon?: { kind: "url"; url: string } | { kind: "monogram"; text: string }` — from
  `manifest.extensions.claxedo.icon` (schema-legal today: `extensions` is an open record), else the monogram of
  `name`. No manifest schema change.
- `skills: Array<{ name: string; description: string; path: string }>` — from `ValidatedAgentPlugin.skills`.
- `source: { id: string; kind: AgentPluginSourceKind | "machine"; label: string; repository?: string }` —
  replaces the free-text `sourceLabel`.
- `mcpServers[*]` unchanged (name, transport, auth state, issuers).

New read route on both rails: `GET /api/claxedo/plugins/:pluginInstanceId/skills/:skill` → `{ name,
description, markdown }` read from the retained artifact tree (never from a live source), 404 when the plugin
is not retained. This is what the detail panel renders when the user opens a skill.

### D2. Sources you add (GitHub)

Generalize `github-public.ts` into `githubRepositoryCatalogSourceProvider({ owner, repository, ref, id, kind })`
and keep the Claxedo collection as one instance. Add a source registry:

- Unsigned: SQLite table `agent_plugin_sources(id, kind='personal', owner, repository, ref, added_at)` in the
  local activation DB (`activation/sqlite-store.ts` family), machine-wide like activation.
- Signed: D1 table `agent_plugin_sources` on `CONTROL_PLANE_DB` (new migration, create-only) with
  `owner_user_id` for personal sources and `org_id` + `authority='organization'` for organization sources;
  organization sources require the same admin/owner role as organization defaults.
- Routes on both rails: `GET /api/claxedo/plugins/sources`, `POST /sources { owner, repository, ref?,
  authority? }` (validates the repository serves at least one plugin before saving; returns the diagnostics
  otherwise), `DELETE /sources/:id`. The catalog lists candidates from every registered source; `source.id`
  on each candidate is what the Directory filters by.
- Import from disk is **out of scope** for this slice (see Non-goals).

### D3. "Personal" — plugins the user installed themselves for other harnesses (read-only discovery)

Local rail only, `GET /api/claxedo/plugins/machine-installed` → `{ harnesses: Array<{ harnessId, entries:
Array<{ name, version?, root, marketplace?, ownedByClaxedo: boolean }> }> }`:

- claude: `~/.claude/plugins/installed_plugins.json` + `known_marketplaces.json` (read-only; tolerate absence
  and malformed files).
- cursor: `~/.cursor/plugins/local/*` excluding entries carrying `.claxedo-agent-plugin.json` (the adapter's own
  marker, `adapters/cursor.ts`).
- codex: `$CODEX_HOME/config.toml` `[plugins.*]` blocks outside the Claxedo marker block + `plugins/cache/*`
  excluding `claxedo-agent-plugins`.

The Directory shows these under **Personal** ("installed by you for these harnesses") with the harness badge.
They are informational: no import action (owner decision 2026-09-04).

### D4. Directory surface (renderer)

`features/agent-plugins/directory/` replaces the single catalog component; `catalog.tsx` is deleted, not kept
beside it.

- **Header**: search over name/description/skill names/MCP server names; source chips `All · Claxedo ·
  <each added source> · Personal · + Add source` (Add source opens a small form: GitHub `owner/repo`,
  optional ref; validation errors from D2 are shown inline).
- **Sections** (in order): *Needs attention* (installed plugins whose OAuth MCP server is `broken`/`degraded`
  or whose artifact is unavailable) → *Installed* → one section per source → *Personal* (D3). Each section is
  a two-column card grid: icon (D1), name, one-line description, a state chip (`Installed on 3 harnesses` /
  `Needs authentication` / `Update available`), primary action `Add` or `Installed ✓`.
- **Detail pane**: a right-side pane inside the marketplace tab (master/detail split inside the surface, not
  the workspace panel, because that panel is bound to workspace state and lifecycle). Content: icon + name +
  version + source, description, **Skills** list (each expands to the SKILL.md markdown from the D1 route via
  the shared rich-text/markdown renderer), **MCP servers** list (transport, auth mode, connection state, and
  the connect / disconnect actions that live inline today), **Where it is installed** (environments, projects,
  harnesses — the same facts the install sheet shows), and the actions `Add / Disable / Use default / Update /
  Enable for organization / Remove organization default` (gating rules unchanged from `catalog.tsx:264-308`).
  Keyboard: `Esc` closes the pane, arrow keys move between cards.
- Mode: unsigned hides source chips that need a signed control plane (organization sources), the project
  column, and organization actions; everything else is identical.

### D5. Install sheet (renderer)

`Add` (or `Enable` from the pane) opens a dialog (`app/dialogs/install-agent-plugin.tsx`) with two steps:

1. **Where it goes** — three groups, each a checkbox list:
   - *Environments*: `Local (this machine)` and `Cloud (your cloud workspaces)`; both checked and **disabled**
     in this slice, with the note "Plugins reach every environment you sign into" (activation has no
     environment dimension; making it editable is a control-plane change, see Non-goals).
   - *Projects*: signed → `All projects` (default) or `Only these projects` with the checkbox list from
     `catalog.projects` (maps to `target`); unsigned → single line "Applies to every project on this machine"
     (the local rail refuses project scope by contract).
   - *Harnesses*: opencode / claude / codex / cursor, all checked (maps to `harnessIds`); harnesses the
     candidate cannot serve are shown disabled with the reason.
2. **Authentication** — only when the plugin has an OAuth MCP server:
   - `Personal — only you` (connection scope `personal`) or `Enterprise — everyone in <org>` (connection scope
     `team` plus `organizationDefault` activation). Enterprise is disabled with the reason when the caller
     lacks `canManageOrganizationConnections` / `canManageOrganizationDefaults`, and hidden when unsigned.
   - `Connect now` opens `DialogConnectIntegration` with the chosen scope (the existing dialog, existing
     `issuer` handling); `Connect later` finishes the install and leaves the row under *Needs attention*.

`Confirm` calls `api.activation({ pluginInstanceId, harnessIds, choice: true, expectedRevision, target })`,
then `organizationDefault` when Enterprise was chosen, then the connection flow. Every step reports the
`reconciliation` state from the mutation receipt; a `202` (reconciliation failed) is surfaced as "installed,
runtime sync pending", never hidden.

### D6. Signed desktop plumbing

New hosted operations in `claxedo-desktop/src/main/account/hosted-operations.ts` and the renderer table
`platform/account/hosted-operations.ts`, all `response: "http"` like the existing `agentPlugins.*` ones:
`agentPlugins.skill`, `agentPlugins.sources.list`, `agentPlugins.sources.add`, `agentPlugins.sources.remove`.
`agent-plugin-account-api.ts` maps them. The machine-installed route is local-only and needs no operation.

## Non-goals (this slice)

- Editable Local/Cloud environment targeting (needs an activation dimension on the control plane).
- Import from disk, hooks/commands/agents in plugins, ratings or usage counts, plugin publishing.
- Importing the Personal section's entries into Claxedo (owner decision: informational only).

## Work packages (disjoint file ownership; run in parallel)

| WP | Owner files | Depends on |
| --- | --- | --- |
| WP1 Catalog contract | `server-core/src/agent-plugins/catalog/**` (candidate view fields, skill reader), `claxedo-server/src/agent-plugins/routes.ts` + `claxedo-local-server/src/agent-plugins/activation/routes.ts` (skill route only), `features/agent-plugins/api.ts` types | — |
| WP2 Sources | `server-core/src/agent-plugins/sources/**`, `claxedo-server/src/agent-plugins/sources-d1.ts` + migration, `claxedo-local-server/src/agent-plugins/activation/sqlite-store.ts` (sources table), sources routes on both rails | — |
| WP3 Machine discovery | `claxedo-local-server/src/agent-plugins/discovery/**` + route | — |
| WP4 Directory UI | `features/agent-plugins/directory/**`, delete `catalog.tsx`, `app/composition/agent-plugin-contribution-loader.tsx` | WP1 types (mock until landed) |
| WP5 Install sheet | `app/dialogs/install-agent-plugin.tsx`, `features/agent-plugins/install/**` | WP1 types |
| WP6 Desktop operations | `claxedo-desktop/src/main/account/hosted-operations.ts`, `claxedo-app/src/platform/account/hosted-operations.ts`, `app/composition/agent-plugin-account-api.ts` | WP1, WP2 route names |
| WP7 Verification | `features/agent-plugins/**/*.vitest.tsx`, `lifecycle.e2e.test.ts` additions, desktop CDP probe run | all |

## Acceptance criteria per work package

- [ ] **WP1** `PluginCandidate.icon/skills/source` present on both rails with one producer in server-core;
      `GET …/skills/:skill` returns the retained SKILL.md and 404s for an unretained plugin; unit tests on the
      view builder and the route on each rail. Progress:
- [ ] **WP2** `POST /sources` with a repository that serves no valid plugin returns the diagnostics and saves
      nothing; a valid repository's plugins appear in the next catalog read with `source.id` set; unsigned
      sources are machine-wide, signed personal sources are per user, organization sources need admin/owner;
      Miniflare test for the D1 store, SQLite test for the local store, route tests on both rails. Progress:
- [ ] **WP3** Personal discovery lists a Claude Code plugin, a Cursor local plugin and a Codex plugin from
      fixture home directories, excludes Claxedo-owned entries, and tolerates missing or malformed files (tests
      with temp homes); the Directory labels the section "Personal" with no import action. Progress:
- [ ] **WP4** Directory renders sections, search, source chips, add-source form, and the detail pane; the
      old `catalog.tsx` is gone and no import references it; vitest covers section membership (needs attention
      vs installed), search, pane open/close, and that every action calls the same API method the old component
      called (one assertion per action). Progress:
- [ ] **WP5** Install sheet shows environments (disabled, both checked), projects (signed) or the machine-wide
      note (unsigned), harnesses, and the auth step only for OAuth plugins; Enterprise gated on both `canManage*`
      flags; confirm issues `activation` then `organizationDefault` then connect, in that order; vitest with a
      fake API asserting the exact bodies. Progress:
- [ ] **WP6** New operations are `response: "http"` on the desktop table and decoded as status results in the
      renderer table; `agent-plugin-account-api.test.ts` extended; the marketplace never calls a decoded op
      through a status reader (regression for the 2026-09-04 defect). Progress:
- [ ] **WP7** Desktop: install Context7 from the Directory on the packaged dev build (signed), CDP probe
      screenshots of Directory, detail pane, install sheet; unsigned run shows the machine-wide note; e2e
      lifecycle test extended for sources. Progress:

## Definition of done

- [ ] `bun run typecheck` in `claxedo-app`, `claxedo-server`, `claxedo-server-core`, `claxedo-local-server`,
      `claxedo-desktop`; `bun run test:architecture-ratchets` green; product-boundary manifests unchanged
      except for the files this plan names. Progress:
- [ ] All WP suites green: server-core catalog tests, both rails' route tests, D1 Miniflare and SQLite store
      tests, discovery tests, app vitest for directory and install sheet, desktop account-api tests. Progress:
- [ ] Live: on the packaged dev build signed into staging, the Directory shows the Claxedo collection, an added
      GitHub source, and the Personal section with this machine's Claude/Cursor/Codex installs; opening Context7 shows its skills and MCP
      server; installing Composio walks Where → Authentication (Personal) → Connect; the VM provisioner still
      delivers revision N+1 (lease ready, apply 200). Progress:
- [ ] Architecture note `docs/agent-plugins-marketplace.md` (present tense: owners, flows, contracts) written;
      this plan's progress log filled; no execution-log docs ship in the eventual PR. Progress:

## Execution: parallelize with agents and workflows

- Run WP1, WP2, WP3 concurrently (server-side, disjoint directories), then WP4, WP5, WP6 concurrently against
  the landed WP1 types, then WP7. Each agent owns only its listed files; shared files (`api.ts`, the two
  `routes.ts`) are touched by exactly one WP each as listed.
- Rules for every agent: work in the shared worktree without `git stash`, `git checkout --`, `git reset`, or
  `git clean`; commit only its own files with `git commit --only`; run the package's real runner
  (`node ./node_modules/vitest/vitest.mjs run` in server packages, `bun test --conditions=browser --preload
  ./happydom.ts` for `.test.ts` and `vitest run --config vitest.config.ts` for `.vitest.tsx` in `claxedo-app`).
- The supervisor reviews every diff against the acceptance criteria above before it is committed, and runs the
  ratchets and the CDP probe (`scratchpad/cdp-probe.mjs`) for the live checks.

## Owner decisions (2026-09-04)

1. **Icons**: `extensions.claxedo.icon` in the plugin manifest, monogram fallback (owner deferred to the
   proposal; no manifest schema change).
2. **Enterprise** = team connection scope **plus** organization-default activation. Confirmed.
3. **Third section is "Personal"**, not "On this machine": plugins the user installed themselves for those
   harnesses (Claude Code, Cursor, Codex). Informational only, no import.

## Progress log

- 2026-09-04: plan written after mapping the current implementation (renderer catalog, both rails, adapters,
  connections dialog, workbench tab). Owner answered the three open questions the same day (see above);
  ready to execute.
- 2026-09-04 (build): executed WP1–WP6 with parallel subagents under supervisor review; commits `5d1ccb7786`
  (icon), `5a244031fd` (WP3), `c033dbffd7` (WP1), `1cfea26e12` (WP5), `7f91f4bb1c` (WP6), `710a6c0df2` (WP2),
  `ffd06039d5` (WP4), `e3b0d2631b` (Directory survives a plane without the sources route), plus polish. Gates:
  typecheck in all five packages, agent-plugins suites (32 vitest + 5 bun), architecture debt ratchet 261,
  closure ceilings re-measured (+6 modules), product boundary green. Staging release 78
  (`release-acc-mkt-260904-174500-3851`) carries the sources routes and migration 0023. Live on the packaged dev
  build, signed: Directory with Installed (composio, context7) and Personal (29 Claude Code/Codex installs),
  detail pane with the composio SKILL.md rendered, the MCP server's personal connection, and Where it is
  installed (Local/Cloud, cross-project default, four harnesses, Personal). Not exercised live: the install
  sheet (both collection plugins are already installed on this account; covered by 13 vitest cases) and adding
  a GitHub source (no second public agent-plugins repository at hand). Follow-ups: the detached daemon writes no
  log of its own (its exit reason on 2026-09-04 could not be recovered); each ad-hoc-signed dev build triggers
  the macOS Keychain prompt on first launch.
- 2026-09-04 (polish): owner review of the first build ("not good enough") led to a design pass (`a609c19f18`):
  no paths on cards, brand tiles, muted status line instead of green pills, small scope/refresh affordances, a
  resizable pane with a breadcrumb skill view and a facts strip under the header, one main action plus an
  overflow menu whose items state their outcome ("Clear my override — follow the organization default (would
  be enabled)"), organization items only for admins/owners, catalog painted from the persisted query cache.
  Perceived slowness traced to cold-isolate GitHub round trips on the hosted rail: edge cache for the ref
  lookup (1 min) and the archive by commit (1 day) — `66601950a9`, staging release 79
  (`release-acc-mkt2-260904-204500-3851`). Two crashes seen live were fixed: a 404 from a plane without the
  sources route (`e3b0d2631b`) and a connection reset during session renewal that took the whole app to the
  crash screen on every launch (`241a5e26d8`: descriptor fetch retries once on a connection-level failure;
  the Directory shows a calm connection-status line with Retry).
- 2026-09-04 (late): three more live findings fixed — opening a skill suspended the whole surface (the document
  read now has its own boundary; Directory resources are read through `.latest` so refetches never suspend),
  the overflow menu was unbounded and end-aligned nowhere, the add-source row misaligned its buttons and said
  nothing about the repository shape. The account flip from the local device to the signed user no longer
  wipes the caches (it revalidates them), which removes the emptied rail and "Loading…" seconds after launch.

## Next slice (owner direction, 2026-09-04): harness-official sources instead of a machine scan

Codex shows other harnesses' curated marketplaces (`claude-plugins-official`, its own bundled set) as sources a
user can install from. Claxedo should do the same: built-in sources per harness (Claude Code's official
marketplace at minimum; Cursor's marketplace and Codex's bundled set where a public listing exists), enabled by
default, each toggleable in "Manage sources", their plugins installable into every harness through the normal
install sheet. This replaces the Personal machine scan (D3/WP3), which is then removed rather than kept beside
it. Design points: a `claude-marketplace` source adapter (Claude's `.claude-plugin/marketplace.json` +
`.claude-plugin/plugin.json` format mapped onto the Agent Plugins model: skills and MCP servers carry over;
commands, agents, hooks are reported as unsupported per plugin, not silently dropped); built-in source records
seeded in both registries with `builtIn: true, enabled: boolean`; the catalog reads only enabled sources; the
Directory groups by source with the harness's mark on the section. Acceptance: Claude's official marketplace
lists in the Directory on both rails, one of its plugins installs into all four harnesses, disabling the source
hides its section on the next read, and the machine-scan route and section are gone.
- 2026-09-04 (night): the blank rail was traced twice more. Cause each time: a principal transition treated as a
  change of person. First `signed(user)` → `org-member(user, org)` when identity resolves; then the interim
  `signed("")` principal published at sign-in (the profile lookup names it a moment later). Both are now
  revalidations (`73328c234d`, `1e7f9b30bd`); a different user, an org switch, or sign-out still wipes.
  "GitHub revision lookup failed with 403" is GitHub's anonymous rate limit on the commit lookup (Workers
  egress shares one budget); the provider now falls back to the archive by ref name and takes a token
  (`b7b063a2de`, staging release 80 `release-acc-mkt3-260904-222000-3851`). Also: container-driven card grid,
  Personal entries open a pane, the overflow menu is bounded, the add-source row explains the repository shape.
  Still open: measured signed-catalog latency (the in-renderer probe caught the account in `unavailable`
  because the descriptor validation had just failed on the edge; retry-once is in, but the plane's flakiness
  remains the owner's environment issue), and the curated harness-official sources slice.
- 2026-09-04 (late night): the rail wipe is closed — the instrumented trace shows every boot transition
  (`local` → `signed:signed-user` → `signed:<id>`) as a refresh and the project count never drops. The interim
  signed principal's placeholder id is now one exported constant (`UNNAMED_SIGNED_USER_ID`). Signed hosted
  operations no longer re-fetch the auth descriptor per call (memoized within its validity, handed out as a
  copy). Hosted inputs are sent as plain JSON copies: the catalog's store proxies broke Electron's structured
  clone ("An object could not be cloned") on Disable. The marketplace is dropped from persisted workbench
  state, so it is never the landing surface after a relaunch. Measured from inside the renderer against
  staging: catalog 3.6–3.9 s, sources 2.9 s, with one 20 s stall and one ECONNRESET in the same minute;
  plain `curl`/Node fetches of `/health` from this machine ranged 0.3–1.8 s with 1.1 s TLS connects, so the
  remaining slowness is this network's path to the edge plus the plane's own work, not the app.
