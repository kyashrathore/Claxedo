# Vocabulary

Canonical glossary for `packages/claxedo-app`. Every term below has one
definition and one canonical implementation. New code MUST use these names
for these concepts. If you find code using a different word for one of these
concepts, that is debt to fix, not a second valid name to keep.

This is not exhaustive prose about the architecture — see `ARCHITECTURE.md`
for directory charters and import rules. This file is the noun list.

## The five senses of "workspace" (read this first)

"workspace" is the single worst naming problem in this codebase: the same
word is used for five unrelated concepts, sometimes in the same file. The
disambiguation refactor (LLD WP-D5) has **partially landed**: the sense-1/sense-2
brands and the sense-1 conflation renames are in; the bulk `directory: string`
relabel is still in progress (see sense 1). For any `workspace`/`workspaceId`
identifier not yet branded, still infer the sense from its file, not its name.

1. **A filesystem directory path** (no separate identity from the path
   string). **Sense 1 is now branded and honestly named.** The brand is
   `DirectoryRef` in `src/shell/identity/brand.ts` (a zero-runtime nominal
   `string` brand; NEVER a control-plane id). The former offender
   `resolveActiveWorkspaceId` is now `resolveActiveDirectory`
   (`src/claxedo-ui/utils/active-workspace.ts:1`), the canonical `activeWorkspaceId`
   memo is now `activeDirectory`, `routeWorkspaceId` is now `routeDirectory`, and
   the route seam `shellRouteWorkspaceKey` is now `shellRouteDirectory(): DirectoryRef`
   (`src/shell/identity/route.ts`). The retired names are CI-fenced by
   `src/architecture/directory-named-workspace.guard.test.ts`. Directories are
   minted as `DirectoryRef` only in the sanctioned owners (`legacy-resolver.ts`,
   the `route.ts` parser, `decodeDirectory`); a growing set of `directory:`
   annotations carry the brand, and the `directoryStringParams` ratchet shrinks as
   the remaining `directory: string` params convert. Target name for any residual
   sense-1 identifier: `activeDirectory` / `directoryRef` (typed `DirectoryRef`).
2. **An opaque control-plane identifier**, distinct from the directory it is
   bound to. `WorkspaceRuntimeSnapshot` in `src/shared/query/runtime.ts:6-8`
   has BOTH a `workspaceId` field and a separate `directory` field on the
   same object — proof the two are not interchangeable even inside one type.
   This is the ONLY sense that should keep the name `workspaceId` once the
   others are renamed. Its brand `WorkspaceId` now exists in
   `src/shell/identity/brand.ts` and is minted at the sole legal narrowing point
   `workspaceIdFromRef` (`legacy-resolver.ts`). Threading `WorkspaceId` through
   the `SessionRef`/`SandboxRef.workspaceId` fields is a future pass (the brand is
   a `string` subtype, so those fields accept the minted value unchanged today);
   `WorkspaceRuntimeSnapshot.workspaceId` stays a raw wire `string` at the schema
   layer by design.
3. **A `toolSandbox.kind` enum value**, distinguishing where a session's
   tools execute from `"local"`/`"virtual"`. `SandboxRef` in
   `src/shell/identity/session-ref.ts:34` declares
   `{ kind: "workspace"; workspaceId: string; hosting: ...; hostId?: string }`;
   `session-ref.ts:57,61,167` switch on this literal (`kind === "workspace"`)
   and `session-ref.ts:96` constructs it. Do not confuse this with
   `session-ref.ts:93,115,170`, which set the unrelated `SessionHost` field to
   `host: "workspace"` — a different literal on the same type-adjacent
   object, not one of the five senses below, but a near-collision in the
   same file that is itself worth knowing about when reading this code.
4. **A project's sub-worktree map.** `LocalProject` in
   `src/context/layout.tsx:67` is `Partial<Project> & { worktree, expanded }`;
   the surrounding store additionally tracks per-project
   `sidebar.workspaces`/`workspacesDefault` UI-expansion state
   (declared `src/context/layout.tsx:98-145`, toggled via the
   `workspaces`/`setWorkspaces`/`toggleWorkspaces` accessors at
   `src/context/layout.tsx:528-537`) and per-project sub-worktrees via
   `project.sandboxes` — a `string[]` on the server `Project` type read in
   `src/context/layout-projects.ts:16,150` and `src/context/global-sync.tsx:143`
   (Wave 2 extracted the project-list logic into `layout-projects.ts`) — a
   project can have multiple of these, each informally called a "workspace".
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
  (`local` / `virtual` / `workspace`, each with its own ref shape).
  `SessionHost` is defined at `src/shell/identity/session-ref.ts:3`; the
  `SandboxRef`/`SessionRef` types (the `toolSandbox` field lives on the latter
  at line 41) at `src/shell/identity/session-ref.ts:32-44`.
  `runnerHost` is the retired predecessor name; it survives in exactly one
  documented backward-compat fallback for old server responses in
  `src/utils/session-url.ts:15-19` (`harnessHost` preferred, `runnerHost`
  read only if `harnessHost` is absent). It must not appear anywhere else.
- **directory** — a filesystem path scoping sessions/tools for one project
  worktree. UI/layout code that currently calls a directory path a
  "workspace(Id)" (sense 1 above) is migrating to `activeDirectory` /
  `directoryRef`.
- **project** — the user-facing grouping shown in the rail. Canonical type:
  `LocalProject` in `src/context/layout.tsx:67`. A second, differently-shaped
  `LocalProject` type is independently declared in
  `src/claxedo-ui/components/dialog-edit-project.tsx:17` — this is a known
  duplicate-type bug (naming-vocab appendix, [high]), not a second legitimate
  definition. There must be exactly one `LocalProject`.

## Harness / runtime

- **harness** — the agent runtime flavor (claude / codex / opencode / ...).
  The single source of truth for the harness-kind set now exists:
  `HARNESS_IDS` / `HarnessId` in `src/shell/identity/session-ref.ts:12-22`
  (eight ids: `claude-acp`, `codex-acp`, `cursor-acp`, `claude-sdk`,
  `codex-app-server`, `cursor-sdk`, `opencode`, `pi`). Both
  `src/shell/harnesses/profile.ts`'s `HarnessKind` (`profile.ts:8`) and
  `src/session/harness/profile.ts`'s `HarnessType` (`profile.ts:4`)
  now derive from it via `= HarnessId`, so the type sets can no longer drift.
  Residual drift to be aware of: `src/session/harness/profile.ts:15`
  still hand-maintains a *runtime* duplicate of the id array (only the type is
  derived), and `src/shared/data/types.ts:18`'s
  `TransportCapabilities.transport` union is a separate transport-flavor list
  (six values, no `cursor-sdk`/`pi`) — not a competing harness-kind home.
  Note: `src/claxedo-ui/harness/harness-preferences.ts` (moved from
  `claxedo-ui/context/` in Wave 2) is a per-harness *preference* store, not a
  definition of the kind enum (`HarnessPreferenceKind` there is
  `"harness" | "model" | "agent"`).
  `"runner"` is the retired predecessor term. It survives as the literal
  string `LEGACY_RUNNER_KEY = "claxedo:runner"` in
  `src/claxedo-ui/harness/harness-preferences.ts:8` (an explicit,
  labeled localStorage-migration compat key) and in
  `src/session/harness/profile.test.ts`'s tests for that legacy-key
  decode path. WP-A8 has landed: `src/components/prompt-input/submit.test.ts`
  no longer contains the word "runner" at all (the ~30 `runnerSetCalls`/
  `runnerSubmitModel`-style test identifiers it once had are now
  harness-named). A few sibling test files still use "runner" as descriptive
  prose in test titles (e.g. `selector-visibility.test.ts`,
  `submit-create-session.test.ts`); the term must not reappear as the live
  name for the concept in production code or new identifiers.
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
  (`src/claxedo-ui/workspace-panel/workspace-panel.tsx`).
- **group** — reserved for session groups only (rail grouping), never a
  synonym for pane/panel.
- Known violation: `src/claxedo-ui/workspace-panel/process-pane-panel.tsx`
  fuses "pane" and "panel" into one name even though its own doc comment
  opens with "Individual process panel within the workspace process side
  panel" — it should be `process-panel.tsx` (or `process-panel-row.tsx`). Do
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

The four product packages are now `@claxedo/*`-scoped: `packages/claxedo-app`,
`packages/claxedo-server`, `packages/claxedo-desktop`, and `packages/claxedo-web`
declare `"name": "@claxedo/app"`, `"@claxedo/server"`, `"@claxedo/desktop"`, and
`"@claxedo/web"` respectively (e.g. `packages/claxedo-app/package.json:2` is
`"@claxedo/app"`). Directories stay `packages/claxedo-*` (the name/dir mismatch
is accepted as cosmetic). The scope drops the `claxedo-` stutter: the scope
carries the brand, the basename says what the package is. This rename was
WP-D4 and is DONE.

Intra-app imports use a single alias: `@/*` → `./src/*` (see `tsconfig.json`'s
path map). WP-D2 retired the former `@claxedo/*` → `./src/*` duplicate alias —
that scope no longer maps to this app's own `src`, so `@/context/...`,
`@/shell/...`, etc. are now the one canonical form. `@claxedo/*` now names real
workspace packages only — the four product packages above plus
`@claxedo/agent-event-runtime` and the other framework packages (and their
subpaths). Freeing the `@claxedo/*` scope from the src-alias duplication in
WP-D2 is what let WP-D4 rename the four product packages into `@claxedo/*`
without a collision.
Design-system/shared packages this app also imports (`@opencode-ai/ui`,
`@opencode-ai/session-ui`) are a separate, intentionally-unrenamed case (they
are shared upstream-lineage UI kits, not one of the four product packages)
and are out of scope for WP-D4.

## What this file does NOT cover

Directory charters, legal import directions, and "where do I add X" live in
`ARCHITECTURE.md`. The `components/` vs `claxedo-ui/components/` layering
question lives in `src/components/README.md`.
