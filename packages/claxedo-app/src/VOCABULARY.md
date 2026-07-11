# Vocabulary

Canonical glossary for `packages/claxedo-app`. Every term below has one
definition and one canonical implementation. New code MUST use these names
for these concepts. If you find code using a different word for one of these
concepts, that is debt to fix, not a second valid name to keep.

This is not exhaustive prose about the architecture — see `ARCHITECTURE.md`
for directory charters and import rules. This file is the noun list.

## The five senses of "workspace" (read this first)

"workspace" is the single worst naming problem in this codebase: the same
word is used for five unrelated concepts, sometimes in the same file. Until
the disambiguation refactor (LLD WP-D5) lands, you must infer which sense a
given `workspace`/`workspaceId` identifier means from its file, not its name.

1. **A filesystem directory path** (no separate identity from the path
   string). `resolveActiveWorkspaceId` in
   `src/claxedo-ui/utils/active-workspace.ts:1` returns a path. Target name:
   `activeDirectory` / `directoryRef`.
2. **An opaque control-plane identifier**, distinct from the directory it is
   bound to. `WorkspaceRuntimeSnapshot` in `src/shared/query/runtime.ts:6-8`
   has BOTH a `workspaceId` field and a separate `directory` field on the
   same object — proof the two are not interchangeable even inside one type.
   This is the ONLY sense that should keep the name `workspaceId` once the
   others are renamed.
3. **A `toolSandbox.kind` enum value**, distinguishing where a session's
   tools execute from `"local"`/`"virtual"`. `SandboxRef` in
   `src/shell/identity/session-ref.ts:17` declares
   `{ kind: "workspace"; workspaceId: string; hosting: ...; hostId?: string }`;
   `session-ref.ts:40,44,150` switch on this literal (`kind === "workspace"`)
   and `session-ref.ts:79` constructs it. Do not confuse this with
   `session-ref.ts:98,153`, which set the unrelated `SessionHost` field to
   `host: "workspace"` — a different literal on the same type-adjacent
   object, not one of the five senses below, but a near-collision in the
   same file that is itself worth knowing about when reading this code.
4. **A project's sub-worktree map.** `LocalProject` in
   `src/context/layout.tsx:61` is `Partial<Project> & { worktree, expanded }`;
   the surrounding store additionally tracks per-project
   `sidebar.workspaces`/`workspacesDefault` UI-expansion state
   (`src/context/layout.tsx:92-139,560-561`) and per-project sub-worktrees
   via `p.sandboxes` (`src/context/layout.tsx:470`) — a project can have
   multiple of these, each informally called a "workspace".
5. **A server the app connects to** (the target vocabulary's own aspirational
   sense — HLD §4: "workspace — a server the app connects to, identified by
   an opaque control-plane workspaceId. NEVER a directory path."). This sense
   is realized nowhere in code today: the concept it describes is
   `ServerConnection` in `src/context/server.tsx:136`, which calls itself
   "server", not "workspace". Once senses 1 and 4 above are renamed away from
   "workspace", `ServerConnection` is the candidate to become the sole
   remaining owner of the word — that rename has NOT happened yet.

**Rule for new code:** never introduce a new use of "workspace" for senses 1
or 4 above. If you need a directory identity, use `directory`/`directoryRef`.
If you need a project sub-worktree, use `worktree`. Only
`WorkspaceRuntimeSnapshot.workspaceId` (sense 2) and the `toolSandbox.kind`
enum value (sense 3, which is load-bearing wire vocabulary and out of scope
to rename) are sanctioned.

## Core identity

- **session / sessionId** — the root identity key of everything in the app;
  most other identifiers (host, toolSandbox, directory) are resolved
  relative to a session. Canonical: `src/shell/identity/session-ref.ts`.
- **host** — where the agent process runs (`SessionHost = "central" |
  "workspace"`). **toolSandbox** — where that session's tools execute
  (`local` / `virtual` / `workspace`, each with its own ref shape). Both
  defined in `src/shell/identity/session-ref.ts:3,10-20`.
  `runnerHost` is the retired predecessor name; it survives in exactly one
  documented backward-compat fallback for old server responses in
  `src/utils/session-url.ts:17-24` (`harnessHost` preferred, `runnerHost`
  read only if `harnessHost` is absent). It must not appear anywhere else.
- **directory** — a filesystem path scoping sessions/tools for one project
  worktree. UI/layout code that currently calls a directory path a
  "workspace(Id)" (sense 1 above) is migrating to `activeDirectory` /
  `directoryRef`.
- **project** — the user-facing grouping shown in the rail. Canonical type:
  `LocalProject` in `src/context/layout.tsx:61`. A second, differently-shaped
  `LocalProject` type is independently declared in
  `src/claxedo-ui/components/dialog-edit-project.tsx:17` — this is a known
  duplicate-type bug (naming-vocab appendix, [high]), not a second legitimate
  definition. There must be exactly one `LocalProject`.

## Harness / runtime

- **harness** — the agent runtime flavor (claude / codex / opencode / ...).
  One kind-enum is the intended source of truth; today it is implemented
  separately in at least `src/session-client/harness/`,
  `src/claxedo-ui/context/harness-preferences.ts`, and
  `src/shared/data/types.ts`'s `TransportCapabilities.transport` union — this
  is known drift (LLD WP-B5 fixes it), not three sanctioned homes.
  `"runner"` is the retired predecessor term. It survives as the literal
  string `LEGACY_RUNNER_KEY = "claxedo:runner"` in
  `src/claxedo-ui/context/harness-preferences.ts:8` (an explicit,
  labeled localStorage-migration compat key) and in
  `src/session-client/harness/profile.test.ts`'s tests for that legacy-key
  decode path. It must not appear as the live name for the concept anywhere
  else — in particular, `src/components/prompt-input/submit.test.ts` still
  names ~30 test cases with "runner" (e.g. `runnerSetCalls`,
  `runnerSubmitModel` at lines 25, 105) even though the code under test is
  the harness-named production path; those names are stale and should read
  "harness", not "runner" (tracked in LLD WP-A8 / naming-vocab appendix).
- **conversation** — the message timeline of a session. Canonical:
  `src/shell/chat/` (e.g. `opencode-conversation.ts`'s
  `applyOpencodeConversationEvent` / `opencodeConversationSnapshot`).

## View-surface words: pane / tab / panel / group

Four distinct concepts, do not use them interchangeably and do not fuse two
into one component name:

- **pane** — a split region of the workbench layout engine. Reducer-level
  concept: `src/claxedo-ui/workbench/reducers/panes.ts`. Also the name of the
  generic (non-workbench) split-pane store at `src/pane/store/`.
- **tab** — a selectable content surface routed inside a pane
  (`src/claxedo-ui/components/page-editor/page-editor.tsx`, the PageEditor surface).
- **panel** — a docked auxiliary surface, e.g. the workspace side-dock
  (`src/claxedo-ui/workspace-panel/WorkspacePanel.tsx`).
- **group** — reserved for session groups only (rail grouping), never a
  synonym for pane/panel.
- Known violation: `src/claxedo-ui/workspace-panel/ProcessPanePanel.tsx`
  fuses "pane" and "panel" into one name even though its own doc comment
  opens with "Individual process panel within the workspace process side
  panel" — it should be `ProcessPanel.tsx` (or `ProcessPanelRow.tsx`). Do
  not copy this pattern in new code.

## "opencode" (lowercase)

Allowed ONLY for:

1. the vendored engine protocol/compat surface and the wire-schema namespace
   from `@opencode-ai/sdk` (Message/Part/Event) that every harness gets
   normalized into — e.g. `opencodeConversationSnapshot` in
   `src/shell/chat/opencode-conversation.ts` applies even to
   non-opencode-harness sessions; this is a deliberate lingua-franca name,
   not a bug;
2. the retired upstream product, in prose only (changelogs, comments
   explaining fork history);
3. one of the six supported harness/transport values in
   `TransportCapabilities.transport` (`src/shared/data/types.ts:18`),
   alongside `claude-acp` / `codex-acp` / `cursor-acp` / `claude-sdk` /
   `codex-app-server`.

Never introduce a new Claxedo UI concept, storage key, DOM id, or
user-visible string spelled "opencode". If you are naming something new and
it is not one of the three cases above, it should say "claxedo" or nothing
brand-specific at all.

## Package scope: `@opencode-ai/*` vs `@claxedo/*`

Verified as of this writing: `packages/claxedo-app`, `packages/claxedo-server`,
`packages/claxedo-desktop`, and `packages/claxedo-web` all still declare
`"name": "@opencode-ai/..."` in their `package.json` (e.g.
`packages/claxedo-app/package.json:2` is `"@opencode-ai/claxedo-app"`), while
every internal Claxedo package this app imports by convention uses
`@claxedo/*` (see `tsconfig.json`'s path map:
`@claxedo/*` → `./src/*`, plus explicit entries for
`@claxedo/agent-event-runtime` and its subpaths). The rename of the four
product packages to `@claxedo/*` scope is tracked as LLD WP-D4 and has NOT
happened yet — do not assume the scope name reflects package identity.
Design-system/shared packages this app also imports (`@opencode-ai/ui`,
`@opencode-ai/session-ui`) are a separate, intentionally-unrenamed case (they
are shared upstream-lineage UI kits, not one of the four product packages)
and are out of scope for WP-D4.

## What this file does NOT cover

Directory charters, legal import directions, and "where do I add X" live in
`ARCHITECTURE.md`. The `components/` vs `claxedo-ui/components/` layering
question lives in `src/components/README.md`.
