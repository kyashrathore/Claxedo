# WP-D5 — Workspace-vs-Directory Identifier Split (Design Note)

Date: 2026-07-11
Status: **proposed / gating (not yet ready to execute — see §0)**
Scope: `packages/claxedo-app` **client-side only** (server boundary is §5, explicitly out of scope)
Author: design-note author for WP-D5

Read first:
- HLD §4 vocabulary — `docs/plans/2026-07-10-001-refactor-claxedo-app-oss-quality-hld.md`
- LLD WP-D5 — `docs/plans/2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md:508-512`
  ("Requires its own detailed design note before execution; do not improvise this one.")
- `packages/claxedo-app/src/VOCABULARY.md` — the five senses of "workspace"
- Alignment target — `docs/plans/2026-07-09-001-refactor-host-owned-runtime-state-plan.md`

Every load-bearing claim below cites `file:line` from the **live working tree**
(which carries uncommitted Wave-2 refactors). Where the live tree and the
committed baseline disagree, both numbers are given.

---

## 0. Readiness verdict (read this before scheduling D5)

**D5 is NOT ready to execute as a single unit today, for two independent reasons.
Both are mechanical to clear; neither is discovered mid-flight.**

1. **The debt-ratchet baseline is stale in the live tree.** The committed
   `src/architecture/debt-baseline.json` pins `directoryStringParams: 332` and
   `userHostedComparisons: 63`; the live tree (Wave-2 uncommitted work) measures
   **345** and **64** respectively (§1.1). The debt-ratchet test asserts *exact*
   equality (`src/architecture/debt-ratchet.test.ts:18-20,60-73`), so
   `bun run test:architecture` — which is the *first* step of `bun run typecheck`
   (`package.json:20`) — is **currently red** on this tree. D5 cannot use the
   ratchet counters as its progress metric (§3) until the leader reconciles the
   baseline. This is a precondition, not a D5 task (Open Question OQ-1).

2. **D5 has hard ordering dependencies that are not yet satisfied.** Per the LLD
   dependency notes (`...-lld.md:545`) D5 lands *solo, last*, after WP-D1
   (session-domain consolidation), WP-D2 (real session-client boundary), and
   WP-D3 (utils dissolution). D5 renames symbols that D1–D3 are still moving
   between files. Executing D5 before them guarantees rebase conflicts on the
   exact files D5 touches (`shell/`, `session/`, `utils/`, `context/`). The
   rename map in §4 is only stable **after** D1–D3 land.

**What this note delivers regardless:** the type model (§2), the staged migration
(§3), the rename map keyed to *concepts* not current paths (§4), and the
boundary/regression contracts (§5–6) — so that when the preconditions clear, the
executor improvises nothing.

**Honest scope-narrowing recommendation:** the `directory: string` annotation
count (345) is a *misleading* headline for D5. It counts every `directory: string`
type annotation in the app, the vast majority of which are correctly-named
directory parameters that should simply gain a branded type — that is a
low-risk, high-volume, mechanical relabel. The *actual risk* of D5 is a much
smaller set: the ~single-digit **conflation sites** where an identifier *named*
`workspaceId` in fact *holds a directory* (§1.3). D5 should be planned as those
two disjoint efforts, and the risky half is small.

---

## 1. Inventory — every `workspaceId`-as-directory-path site class

### 1.1 Ratchet counters (authoritative live measurement)

Measured by running the real scanner (`src/architecture/scanners.ts`
`metricCounts(walkProdSources(...))`, which excludes `*.test.*`, `*.vitest.*`,
`*.d.ts`, and `src/architecture/**`). Counts confirmed by direct invocation of
the scanner against the live tree.

| Metric (scanner regex) | Committed baseline | **Live tree** | What it measures | D5 relevance |
|---|---|---|---|---|
| `directoryStringParams` (`/directory:\s*string/g`) | 332 | **345** | every `directory: string` type annotation | Primary bulk relabel target (§3-S3) |
| `isFilesystemDirectory` (`/isFilesystemDirectory\s*\(/g`) | 11 | **11** | calls that sniff a fs-path string | Contained in `legacy-resolver.ts` (§1.4) |
| `isWorkspaceIdRef` (`/isWorkspaceIdRef\s*\(/g`) | 2 | **2** | calls that sniff a `ws_`-shape string | Contained (§1.4) |
| `filesystemShapeRegexClones` | 2 | **2** | copy-pasted `startsWith("/")\|\|/^[A-Za-z]/` | Contained (§1.4) |
| `userHostedComparisons` (`=== "user-hosted"`) | 63 | **64** | `kind` discriminant string compares | Adjacent, not D5 (kind enum, VOCABULARY sense-3-adjacent) |
| `legacyDirectoryRouteKeyRefs` | 2 | **2** | `legacyDirectoryRouteKey` refs | Route layer, already typed (§1.2) |
| `isLoopbackHttpUrl` | 4 | **4** | loopback-URL sniff | Not D5 (URL, not directory) |

> The committed baseline being 13/1 below live is the §0.1 blocker: the ratchet
> is a *shrink-only exact pin* (`debt-ratchet.test.ts:60-73`) and is red now.

### 1.2 The route layer — already correctly typed (do not touch)

`src/shell/identity/route.ts` is the one place where the two senses are already
*discriminated at the type level*. `ShellRoute` (`route.ts:3-11`) is a tagged
union whose `workspace*` variants carry `workspaceId: string` (sense 2) and
whose `legacy-directory` variant carries `directory: string` (sense 1) — two
separate fields on two separate variants.

- Route constructors keep them separate: `workspaceRoute` (`route.ts:47-49`,
  `/w/:workspaceId`), `legacyDirectoryRouteKey` (`route.ts:71-73`,
  base64-encoded directory as the `/:dir` segment).
- `app.tsx` mounts them as distinct routes (`app-route-spine`
  markers `path="/w/:workspaceId"` and the catch-all `/:dir`, enforced by
  `scanners.ts:174-182`).

**The type-erasure point is one function:** `shellRouteWorkspaceKey`
(`route.ts:141-153`) collapses *both* variants into a single untyped `string`
return — `case "workspace": return route.workspaceId` **and**
`case "legacy-directory": return route.directory`. Everything downstream of this
call receives a `string` that is *either* a control-plane id *or* a directory,
with no way to tell which. This function is the seam D5 must re-type (§3-S2).

### 1.3 The conflation sites — the actual risk surface (small, named)

These are identifiers *named* `workspaceId` (sense-2 vocabulary) that at runtime
*hold a directory* (sense 1). This is the set that makes D5 "highest risk," and
it is small:

- **`src/shell/app-shell-state.ts:90-95`** — the canonical offender.
  `activeWorkspaceId` is a `createMemo` that returns
  `resolveActiveWorkspaceId({ routeDir: routeWorkspaceId(), surfaceDir: realDirectory(...) })`
  — i.e. a **directory path**, named `workspaceId`. It then feeds:
  - `activeProjectId` (`app-shell-state.ts:104-113`) which matches it against
    `p.worktree` / `p.sandboxes` (directory comparisons);
  - `ensureDirectorySessionCache(dir)` (`app-shell-state.ts:73-75,125-129`);
  - `notification.setActiveScope({ directory: activeWorkspaceId() })`
    (`app-shell-state.ts:135-140`) — passed *explicitly as `directory`*.
  This single misnamed memo is exported and consumed as `activeWorkspaceId` at
  **71 occurrences across 21 files** (`shell/app-shell-*.ts(x)`,
  `claxedo-ui/layout-actions/*`, `claxedo-ui/rail/*`,
  `claxedo-ui/utils/workspace-scope-ids.ts`).
- **`src/claxedo-ui/utils/active-workspace.ts:1-7`** — `resolveActiveWorkspaceId`
  takes `{ routeDir, surfaceDir }` and returns one of them: the function *name*
  says `WorkspaceId`, the parameter *names* say `Dir`. VOCABULARY.md:19-21 cites
  this exact file as sense-1.
- **`src/shell/app-shell-route-sync.ts:42,54,76,97,103`** — proof the target
  name already coexists with the wrong one:
  `route-sync.ts:76` writes `activeDirectory: input.activeWorkspaceId()` — the
  *correct* target key (`activeDirectory`) fed *from* the misnamed source
  (`activeWorkspaceId()`). Lines 42/54/97/103 pass `activeWorkspaceId()` into
  `routeDir` / `dir` / `fallbackDir` slots.
- **`src/shell/identity/session-view-key.ts:23`** — `const workspaceId =
  input.workspaceId?.trim() || input.directory?.trim()` — a local named
  `workspaceId` that is a **union of a real workspaceId OR a directory** in raw
  string form. This is the sense-1/sense-2 collision in a single expression.
- **`src/context/global-sync.tsx:186`** — `group.workspaceId === directory`
  compares a (sense-2) field against a (sense-1) directory string, relying on
  the historical fact that unbacked groups stored the directory *in* the
  `workspaceId` slot.

Partial migration already in flight (target names present, proof the direction
is settled): `activeDirectory` appears in
`app.tsx:141`, `context/global-sync.tsx:97-98`,
`context/claxedo-events.tsx:273-274`, `shell/app-shell-route-sync.ts:76`,
`claxedo-ui/state/surface-route.ts:108,119-120,130`.

### 1.4 The containment layer — where directory-shape sniffing is *legitimately* concentrated

`src/shell/identity/legacy-resolver.ts` is "the ONE file allowed to sniff legacy
directory strings" (its header comment, `legacy-resolver.ts:1-2`). It owns
`isFilesystemDirectory` (`:4-6`), `isWorkspaceIdRef` (`:8-10`),
`workspaceIdFromRef` (`:12-16`), `isUserHostedWorkspaceDirectory` (`:26-29`),
`requiresSignedLegacyDirectory` (`:31-33`), `isLocalSessionDirectory` (`:35-39`).

The route-audit linter (`src/utils/workspace-runtime-route-audit.test.ts`, 3353
lines) enforces this containment through several boundary sets:
- `workspaceSelectorSyntaxBoundary` (route-audit `:47-55`) — only listed files
  may reference `isWorkspaceIdRef`/`workspaceIdFromRef` (`:305-331`).
- `workspaceRuntimeIdentityBoundary` (`:40-45`) — only listed files may derive a
  workspaceId from a directory ref (`workspaceIdFromDirectoryRef`, `:312-318`).
  Note `workspaceIdFromDirectoryRef` **no longer has a definition** — WP-A2
  collapsed it into `workspaceIdFromRef` (route-audit `:322-329`); the name
  survives only as forbidden-token guards.
- "raw legacy string-shape predicate names stay inside the resolver owner"
  (`:333-372`) — a file may only *use* these names if it *imports* them from
  `legacy-resolver.ts` and does not *re-declare* them.

**Implication for D5:** the directory-sniffing debt is already fenced to one
owner and CI-guarded. D5 does not need to eliminate the sniffing; it needs to
(a) give the *thing being sniffed* a branded type so the sniffers are the only
legal `string → DirectoryRef` narrowing point, and (b) rename the *conflation
identifiers* in §1.3 so no `workspaceId`-named symbol carries a directory.

### 1.5 The directory→control-plane-id bridge (the legitimate crossing)

`src/shell/workspace/session-workspace-key.ts` `sessionWorkspaceRuntimeRef`
(`:22-` onward) is the sanctioned bridge: it takes `{ directory: string,
sessionRef?, projects? }` and resolves a `{ workspaceId, kind }` (sense 1 →
sense 2). This is *correct* conflation (an explicit resolution), not a naming
bug. D5 should preserve this function as the single typed crossing:
`(DirectoryRef, inventory) → WorkspaceId | undefined`. The route-audit binds its
`sessionWorkspaceRuntimeRef` usage as the required replacement for the retired
`workspaceIdFromDirectoryRef` at ~10 call sites (route-audit
`:268,277,279,281,608`, etc.).

### 1.6 Layer distribution of the bulk relabel target (`directory: string`)

Live tree, prod only, excluding `architecture/`:

| Layer | `directory: string` decls | `workspaceId(?): string` decls |
|---|---|---|
| `claxedo-ui/` | 37 | 15 |
| `shell/` | 15 | 26 |
| `context/` | 14 | 6 |
| `shared/` | 11 | 7 |
| `utils/` | 7 | 4 |
| `components/` | 7 | 8 |
| `session/` | 3 | 2 |
| `pages/` | 3 | 5 |
| `session-client/` | 1 | 5 |
| `agent-runtime/` | 2 | 4 |
| others (marketplace/demo/process/cloud/terminal) | ~8 | ~5 |

Totals: **345** `directory: string`, **251** `workspaceId(?): string` decls;
`workspaceId` as a bare identifier appears **2159** times across **129** prod
files. These totals set the blast radius scale and argue for the staged,
type-first approach in §3 rather than a single sweeping rename.

---

## 2. Target type model

### 2.1 Precedent already in the tree (do not reinvent)

Branded string types **already exist** in this app and are the pattern to follow:

- `src/shell/data/keys.ts:3` — `type Brand<T, Name extends string> = T & { readonly __scope: Name }`,
  used for `SessionScopedQueryKey` / `WorkspaceScopedQueryKey` (`keys.ts:5-6`).
- `src/pages/directory-layout.tsx:15-22` — `type ProjectDirString = string & { readonly __brand: "ProjectDirString" }`
  with a `decodeDirectory(dir: string): ProjectDirString | undefined` decoder.
  **But it is inert**: it is declared, and even its own consumer bypasses it
  (`directory-layout.tsx` `directory` memo returns `decode64(params.dir) ?? ""`,
  a plain `string`, not the brand). It is a leftover from an `effect`
  `Schema.String.brand` and is used nowhere else in prod
  (grep: only `directory-layout.tsx:15-22`).

The `session-ref.ts` "branded-Key pattern" the LLD references is **not** TS
nominal branding — it is the **opaque-accessor-function** pattern:
`sessionKey(ref)` / `workspaceKey(ref)` (`session-ref.ts:52-58`) return `string`
but callers are expected to go *through the accessor*, and
`resolveWorkspaceRef(ref): WorkspaceBacking` (`resolve-workspace-ref.ts:9-16`)
returns a *discriminated union* (`{ kind: "none" | "local" | "cloud" |
"user-hosted"; ... }`) rather than a bare id. That union is the real model:
the *kind* tells you which sense you hold.

### 2.2 Decision: two nominal brands + preserve the accessor/union pattern

Introduce two zero-runtime-cost nominal brands, reusing the existing `Brand<>`
utility (promote it out of `shell/data/keys.ts` into a shared identity module,
e.g. `shell/identity/brand.ts`, so both keys.ts and the new types consume one
`Brand`):

```ts
// shell/identity/brand.ts  (promoted from keys.ts:3)
export type Brand<T, Name extends string> = T & { readonly __scope: Name }

// shell/identity/directory-ref.ts
export type DirectoryRef = Brand<string, "DirectoryRef">   // sense 1: a filesystem path
// WorkspaceId — sense 2: an opaque control-plane id. NEVER a directory.
export type WorkspaceId  = Brand<string, "WorkspaceId">
```

Rationale for **nominal brands over a discriminated union of new object types**:
- The wire and the router already pass these as bare strings
  (`/w/:workspaceId`, `?directory=`, `x-workspace-id` header — §5). A branded
  string keeps the runtime representation identical (zero migration risk at I/O
  boundaries; the brand is erased at compile time) while making the *compiler*
  reject `directory → workspaceId` assignment.
- `ProjectDirString` proves the team already reached for exactly this and it did
  not "drag the effect runtime into boot" (`directory-layout.tsx:15-16`).
  `DirectoryRef` **subsumes and replaces** `ProjectDirString` (fold the decoder
  `decodeDirectory` onto `DirectoryRef`).
- The single legal `string → DirectoryRef` narrowing point is
  `legacy-resolver.ts` (already the CI-fenced owner, §1.4). The single legal
  `string → WorkspaceId` narrowing point is `isWorkspaceIdRef`/`workspaceIdFromRef`
  (same owner). Everywhere else, the brand must be *received*, never minted.
- The single legal `DirectoryRef → WorkspaceId` crossing is
  `sessionWorkspaceRuntimeRef` (§1.5).

**Explicitly rejected:** wrapping in object types (`{ dir: string }`) — churns
every I/O call and every route param for no additional safety over a brand;
and a global find-replace of `workspaceId`→`directoryRef` — see §1.3, most
`workspaceId` occurrences are *correctly* sense-2 and must keep the name.

### 2.3 Where each brand lives after D5

| Concept | Brand | Canonical mint site | Canonical consumers |
|---|---|---|---|
| filesystem directory path (sense 1) | `DirectoryRef` | `legacy-resolver` decode / `decodeDirectory` | UI/layout/route `legacy-directory` variant, `directory:` params |
| control-plane id (sense 2) | `WorkspaceId` | `workspaceIdFromRef` / route `/w/:workspaceId` / server response | `SandboxRef.workspaceId`, `SessionRef.workspaceId`, runtime targets |
| the two-sense route key | *removed* — `shellRouteWorkspaceKey` split into `shellRouteDirectory(): DirectoryRef?` and `shellRouteWorkspaceId(): WorkspaceId?` | `route.ts` | `app-shell-state.ts` |

`SandboxRef`/`SessionRef`/`WorkspaceSessionBacking` in `session-ref.ts:32-50`
adopt `WorkspaceId` for their `workspaceId` fields; the `kind: "local"` variant
adopts `DirectoryRef` for `cwd`. The `toolSandbox.kind === "workspace"` *enum
literal* (VOCABULARY sense 3) is untouched — it is wire vocabulary.

---

## 3. Migration strategy — mechanically-verifiable stages

Each stage ends **green** on `bun run typecheck` (which is
`test:architecture` → `tsgo -b` → `test:performance`, `package.json:20`) and the
targeted test lists. Stages are independently landable; the ratchet counters are
the progress metric **once OQ-1 clears**.

**Stage S0 (precondition, leader-owned, not D5):** reconcile
`debt-baseline.json` to the live tree (`bun run scripts/update-debt-baseline.ts`)
so the ratchet is green before D5 starts. Blocks all following stages.

**Stage S1 — introduce the brands, mint nowhere new.** Add
`shell/identity/brand.ts` (promote `Brand<>`), `DirectoryRef`, `WorkspaceId`.
Retype the two owner functions to *return* the brands
(`workspaceIdFromRef(...): WorkspaceId | undefined`, `decodeDirectory(...):
DirectoryRef | undefined`, fold `ProjectDirString` into `DirectoryRef`). Add a
guarded `asDirectoryRef`/`asWorkspaceId` cast helper **only** inside
`legacy-resolver.ts`. *Verification:* typecheck green; no counter moves yet
(brands are additive). Add a new scanner metric `unbrandedWorkspaceMint`
(baseline = current count) that flags `as DirectoryRef`/`as WorkspaceId` outside
the resolver owner — seeds the ratchet for S3/S4.

**Stage S2 — re-type the route seam.** Split `shellRouteWorkspaceKey`
(`route.ts:141-153`) into `shellRouteDirectory(): DirectoryRef | undefined` and
`shellRouteWorkspaceId(): WorkspaceId | undefined`. Update the two callers
(`app-shell-state.ts:88`, `shellRouteWorkspaceKeyFromPathname` at `route.ts:155-157`).
*Verification:* `route.test.ts` (route parser suite) + typecheck. This is the
highest-value stage — it makes the compiler enforce the sense at the origin.

**Stage S3 — rename the conflation identifiers (§1.3), the risky core.** In
dependency order from the seam outward:
`resolveActiveWorkspaceId` → `resolveActiveDirectory`,
`activeWorkspaceId` memo → `activeDirectory`,
`routeWorkspaceId` → `routeDirectory`,
`session-view-key.ts:23` union split. Because the target name `activeDirectory`
already exists at consumer sites (`app-shell-route-sync.ts:76`,
`surface-route.ts`), several call sites *simplify* (drop the rename-shim).
Retype `activeDirectory` as `DirectoryRef`. *Verification:* typecheck forces
every one of the 71 occurrences to be consistent — the compiler is the test.
Plus `app-shell-state`/route-sync targeted tests, and browser-verify routing
(directory route, `/w/` route, deep links) per HLD §6.

**Stage S4 — bulk relabel `directory: string` → `directory: DirectoryRef`.**
Mechanical, layer-by-layer (order by §1.6 ascending blast radius:
`session-client`/`session`/`pages` first, `claxedo-ui`/`shell`/`context` last).
Each layer is one landable commit; `directoryStringParams` ratchet **shrinks
monotonically** as annotations convert (retype the metric to count only
*unbranded* `directory: string`, or add `directoryRefParams` as the shrink
target). *Verification:* per-layer typecheck + that layer's test files; ratchet
strictly decreases.

**Stage S5 — lock it in.** Add a `retired-vocabulary`-style guard
(pattern: `retired-vocabulary.guard.test.ts:1-40` + baseline JSON) named e.g.
`directory-named-workspace.guard`: flags any identifier matching
`/\bactiveWorkspaceId\b|\brouteWorkspaceId\b/` (the retired conflation names) and
any `workspaceId: string` that is assigned a `DirectoryRef` (compiler already
catches the latter; the guard catches the *names* creeping back). Update
`VOCABULARY.md:11-59` to mark sense 1 as resolved and point at `DirectoryRef`.

---

## 4. Rename map for public symbols

Keyed to **concept**, not current path (paths shift under D1–D3; resolve against
the live tree at execution time).

| Current symbol | Current location (live) | Target | Sense |
|---|---|---|---|
| `resolveActiveWorkspaceId` | `claxedo-ui/utils/active-workspace.ts:1` | `resolveActiveDirectory` | 1 |
| `activeWorkspaceId` (memo + return field) | `shell/app-shell-state.ts:90,160,175`; +20 consumer files | `activeDirectory` | 1 |
| `routeWorkspaceId` (memo) | `shell/app-shell-state.ts:88`; `app-shell-route-sync.ts` param | `routeDirectory` | 1 |
| `shellRouteWorkspaceKey` | `shell/identity/route.ts:141` | split → `shellRouteDirectory` + `shellRouteWorkspaceId` | both |
| `shellRouteWorkspaceKeyFromPathname` | `route.ts:155` | `shellRouteDirectoryFromPathname` (+ id variant) | both |
| `openWorkspaceScopeIds({ activeWorkspaceId })` arg | `claxedo-ui/utils/workspace-scope-ids.ts` | `{ activeDirectory }` | 1 |
| `ProjectDirString` | `pages/directory-layout.tsx:17` | fold into `DirectoryRef` (delete local brand) | 1 |
| `Brand<T,Name>` | `shell/data/keys.ts:3` | promote → `shell/identity/brand.ts` (shared) | — |
| `sessionWorkspaceRuntimeRef` | `shell/workspace/session-workspace-key.ts:22` | **unchanged name**; retype `(DirectoryRef,inv) → { workspaceId: WorkspaceId, kind }` | 1→2 bridge |
| `SandboxRef.workspaceId`, `SessionRef.workspaceId`, `WorkspaceSessionBacking.workspaceId` | `shell/identity/session-ref.ts:34,40,47` | **unchanged name**; retype `string` → `WorkspaceId` | 2 |

**Names that MUST NOT change** (sense 2 / sense 3 — the sanctioned survivors per
VOCABULARY.md:54-59): `WorkspaceRuntimeSnapshot.workspaceId`
(`shared/query/runtime.ts:6`), the `toolSandbox.kind === "workspace"` literal,
`workspaceKey`/`workspaceIdFromRef`, `/w/:workspaceId` route,
`x-workspace-id` header, every server-facing `workspaceId`.

---

## 5. Blast radius & the client/server boundary

**D5 is client-side only. State this in the PR description.** The server-side
half is the *separate* directory-shape routing fix
(`project_directory_shape_routing_fix` memory / plan `2026-07-09-001`).

Packages *outside* `claxedo-app` that observe these identifiers, and why D5 does
**not** touch them:

- **`packages/claxedo-server/src`** — accepts *both* keys on the wire today and
  must keep doing so: `resolveWorkspace({ directory })` from
  `?directory` / `x-opencode-directory` header
  (`server-workspace-pty-proxy.ts:55-57`) **and**
  `resolveWorkspace({ workspaceId })` from `?workspaceId` / `?workspace` /
  `x-workspace-id` header (`server-workspace-pty-proxy.ts:55-56,228-234`); route
  param `:workspaceId` (`server-workspace-pty-proxy.ts:216,228`);
  `session-list.ts:28,73,118,131,237,337` carries `directory` and `workspaceId`
  as distinct request fields. `workspaceId` appears ~2180×, `directory` far more
  in `workspace-runtime` (~1413× vs 244× `workspaceId`). These are the *wire
  contract*: a client-side brand is erased at compile time, so the serialized
  request bytes are **identical** before and after D5. **D5 changes zero server
  code and zero wire shapes.**
- **`packages/workspace-runtime/src`** — the runtime keys almost everything by
  `directory` (its cwd), resolving `workspaceId` at the edge. Out of scope;
  owned by 2026-07-09-001.
- **`@opencode-ai/sdk`** — `VcsInfo` etc. (`shared/query/runtime.ts:1`) are
  vendored wire schemas; untouched.

The **only** cross-package coupling D5 must respect: the dual-key request
builders in `claxedo-app` (`utils/workspace-runtime-request.ts`,
`utils/workspace-control-routes.ts`, `shell/data/transport/transport.ts`) must
keep emitting *both* `directory` and `workspaceId` where they do today — the
brand types constrain *which local variable* feeds each, not *whether the key is
sent*.

---

## 6. Don't-regress list

1. **Do not loosen any `architecture/` ratchet** (HLD §8). `directoryStringParams`
   and friends shrink monotonically; never edit `debt-baseline.json` upward
   except the S0 reconciliation (which the leader, not D5, owns).
2. **Do not change the wire.** Every request still sends both `directory` and
   `workspaceId` keys where it does today (§5). Brands are compile-time only.
3. **Do not rename the sanctioned sense-2/sense-3 survivors** (§4 lower block).
   In particular `WorkspaceRuntimeSnapshot.workspaceId`
   (`shared/query/runtime.ts:6`) keeps *both* its `workspaceId` and its
   `directory` field — that dual shape is VOCABULARY.md's own proof (`:22-25`)
   the senses are distinct.
4. **Do not mint a brand outside its owner.** `string → DirectoryRef` /
   `→ WorkspaceId` only inside `legacy-resolver.ts` (and `route.ts` for route
   params). Enforced by the S1 scanner metric.
5. **Do not disturb the containment linter** (`workspace-runtime-route-audit.test.ts`,
   3353 lines): its boundary sets (`workspaceSelectorSyntaxBoundary`,
   `workspaceRuntimeIdentityBoundary`, `:305-372`) must stay green. Renaming a
   file in the boundary set requires updating the set in the same commit.
6. **Do not preempt D1–D3.** The rename map targets files that D1
   (session consolidation), D2 (session-client boundary), D3 (utils dissolution)
   are still moving. D5 lands *after* them (`...-lld.md:545`).
7. **Terminal/routing browser-verify** (HLD §6, §8): S2/S3 touch routing;
   exercise the `/:dir`, `/w/:workspaceId`, and deep-link paths in a real
   browser, not just typecheck.
8. **`sessionWorkspaceRuntimeRef` keeps its exact resolution semantics**
   (`session-workspace-key.ts` — the "local backing does not prove local pane"
   fall-through, `:` comment block). Retype only; do not simplify the logic.

---

## 7. Open questions for the leader

- **OQ-1 (blocking):** Who reconciles `debt-baseline.json` (live 345/64 vs
  committed 332/63) and when? The debt-ratchet is red on this tree *now* (§0.1);
  D5 cannot begin measuring progress against a red baseline. Is this the pending
  "debt-ratchet baseline bump" the e2e session owns (`...-lld.md:517-519`)? If
  so, D5 waits on that commit.
- **OQ-2 (ordering):** Confirm D5 runs strictly after D1/D2/D3 land
  (`...-lld.md:545`). If the leader wants to pull the *bulk relabel* (S4,
  low-risk) forward while deferring the *conflation rename* (S3, risky), that is
  a viable split — but S4 touches files D3 moves, so it still serializes after
  D3. Decide: one D5, or D5a(brands+relabel)/D5b(conflation rename)?
- **OQ-3 (metric shape):** Should S4 retype `directoryStringParams` to count
  only *unbranded* `directory: string` (so it shrinks as annotations convert),
  or add a parallel `directoryRefParams` counter and let the old one hit zero?
  The former reuses the ratchet; the latter is clearer in the diff.
- **OQ-4 (`userHostedComparisons`, 64):** These `=== "user-hosted"` compares are
  a *kind*-enum concern (VOCABULARY sense-3-adjacent), not directory-vs-id. Are
  they in D5's charter at all, or a separate kind-enum-unification WP? This note
  assumes **out of scope** for D5.
- **OQ-5 (scope of the brand at I/O):** Should `WorkspaceRuntimeSnapshot`
  (`shared/query/runtime.ts:5-18`) adopt `WorkspaceId`/`DirectoryRef` on its
  fields, or stay `string` because it is a wire-shape type? Recommendation: stay
  `string` at the wire-schema layer, brand only *after* it crosses into app
  state — but the leader should ratify where the "wire string → branded" line
  sits.
- **OQ-6 (`shellRouteWorkspaceKey` consumers):** the split in S2 changes a
  public-ish helper. Confirm no code *outside* `claxedo-app` imports
  `shell/identity/route.ts` (grep shows it is app-internal; re-verify at
  execution time after D1–D3 shuffle imports).
```