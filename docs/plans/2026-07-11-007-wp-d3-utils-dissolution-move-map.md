# WP-D3 · utils/ Dissolution — Pre-Scoping Move Map (2026-07-11)

READ-ONLY pre-scoping for Wave 4 / WP-D3 (`docs/plans/2026-07-10-002-...-lld.md` §Wave 4,
lines 492–502). **Authority:** the cluster→home map in appendix-004
`docs/plans/2026-07-10-004-claxedo-app-org-review-appendix.md` **support-dirs-org →
proposed_tree → "SCOPE 2 — utils/ dissolution"** (appendix lines 504–518). This doc maps that
authority against the **live post-Wave-2 tree** and flags every place the appendix is stale.
No source edits; no commits. All claims cite `file:line` or a grep/guard count.

Root for all `src/...` paths: `packages/claxedo-app/src/`.

---

## 0. Headline divergences (appendix is stale in five concrete ways)

The appendix was authored 2026-07-10 against the pre-Wave-1/1.5 tree. Since then Wave 1 deleted
files and Wave 1.5 moved files *into* utils/. The authority table must be read with these
corrections:

| # | Appendix says | Live tree (verified) | Consequence for D3 |
|---|---------------|----------------------|--------------------|
| D-1 | target home is **`runtime/`** (existing dir) for the transport trio (appendix L510, LLD L496) | `src/runtime/` **does not exist**; renamed to **`agent-runtime/`** in Wave 2 (`ls src/` — no `runtime/`; `agent-runtime/` present with `agent-runtime-client.ts` etc.) | Retarget the transport trio to **`agent-runtime/`**, not `runtime/`. The dir's charter (`agent-runtime/AGENTS.md`) already fits. |
| D-2 | **delete** cluster: `index.ts, agent-cache.ts, aim.ts, runtime-adapters.ts, terminal-writer.ts, local-selection-handoff.ts, project-meta-cache.ts` (appendix L515) | **All 7 already absent** (deleted in Wave 1). Also gone: `resolve-runtime-target.test.ts`, `terminal-websocket-url.ts` (appendix L406/L448 move targets) | The "delete" step and the `resolve-runtime-target.test.ts`→rename and `terminal-websocket-url.ts`→`terminal/` steps are **no-ops**. Do not plan them. |
| D-3 | (not mentioned) | **New residents moved into utils/ by Wave 1.5** that the table never classified: `analytics.ts`, `lru-map.ts`, `file-picker.ts`, `notification-permission.ts(+test)`, `persist.ts(+test)`, `usage-limits-api.ts`, `dialog-select-directory-routes.ts` | Each needs an explicit home decision (see §1). `persist.ts` is the important one — it is **not dependency-free** (imports `@claxedo/context/platform`), so it cannot land in the "slim dependency-free utils/" end-state unclassified. |
| D-4 | primitives-stays list cites `agent.ts` etc. as the slim residual (appendix L508) | Live residual after moves is **~26 files**, not "~25", once the D-3 new residents are folded in | Update the slim-utils target count; the appendix's "68→~25" arithmetic predates both the Wave-1 deletions and the Wave-1.5 move-ins. |
| D-5 | route-audit "3220-line" / "68 flat files" (appendix L387/L429) | Live utils/ is **67 entries** = 48 non-test `.ts` + 18 `.test.ts` + `test-support/` dir; `workspace-runtime-route-audit.test.ts` is now **193 KB** (`ls -la`), grep shows **26** `utils/` path literals inside it | Size/count figures in the appendix are stale; the audit test grew. Its relocation to `architecture/` as a scanner is unchanged in intent. |

**Bottom line:** the *direction* of every appendix cluster is still correct; only the `runtime/`→`agent-runtime/`
retarget (D-1), the already-done deletes (D-2), and the seven unclassified new residents (D-3) require
divergence handling.

---

## 1. Current utils/ inventory (67 entries) — per-file target

Importer counts = distinct **src/** files importing the module, excluding the module's own
`.ts`/`.test.ts` (grep `utils/<name>("|'|.js)` over `src/`). "test?" = colocated test present.

### 1a. STAYS in utils/ — dependency-free primitives (verified pure: no cross-dir import)

`agent.ts`, `array.ts` (2 imp), `base64.ts`, `binary.ts`, `debug.ts`, `encode.ts`,
`fetch-throttle.ts`(+test), `id.ts`, `iife.ts`, `notification-click.ts`, `path.ts`,
`path-key.ts`, `retry.ts`, `same.ts` (5 imp), `scoped-cache.ts` (2 imp), `server-errors.ts`
(3 imp), `sound.ts`(+test), `time.ts`, `url.ts`(+test), `uuid.ts` (2 imp), `diffs.ts` (3 imp).
Purity spot-checked: `server-errors, diffs, scoped-cache, analytics, file-picker, lru-map,
notification-permission, agent, fetch-throttle, debug` all return **zero** cross-dir imports.

Plus **Wave-1.5 new residents that ARE pure and correctly stay** (D-3):
`analytics.ts` (14 imp — from `analytics/posthog.ts`, LLD L204), `lru-map.ts` (from
`vite-shims/`, LLD L206), `file-picker.ts` (1 imp — from `constants/`, LLD L205),
`notification-permission.ts`(+test).

### 1b. STAYS but DIVERGES from appendix — new residents needing an explicit decision (D-3)

| File | imp | test? | Issue / recommended home |
|------|-----|-------|--------------------------|
| `persist.ts`(+test) | 20 (context×many, browser, components, claxedo-ui, index/main) | yes | **Imports `@claxedo/context/platform` (value).** Not dependency-free ⇒ violates the "slim utils = primitives only" end-state. Also **the sole reason `context<->utils` survives dissolution** (§4). Needs a home decision: keep in utils/ (accept the residual cycle) or move to `shared/` / a persistence home. Appendix never classified it. |
| `usage-limits-api.ts` | 1 (claxedo-ui) | no | API client; `import { ... } from "./api"`. **Follows `api.ts` → `shared/data/`** (tokentracker-era file, post-dates appendix). |
| `dialog-select-directory-routes.ts` | 2 (components, context) | no | Pure workspace-runtime URL builders (no imports). Wave-1.5 moved it *into* utils/ (LLD L257). It is a **sibling of `workspace-control-routes.ts`** which goes to `agent-runtime/` — recommend it **follows to `agent-runtime/`**, not left in utils/. Decision gap. |

### 1c. → `shared/query/` — TanStack-Query cache accessors (appendix L509)

| File | imp | test? | Note |
|------|-----|-------|------|
| `directory-config-cache.ts` | 1 (context) | no | test gap |
| `directory-search-cache.ts` | 1 (components) | no | test gap |
| `file-request-cache.ts` | 2 (context) | no | test gap |

(Appendix's "agent-cache / project-meta-cache: delete, dead" — **already gone**, D-2.)

### 1d. → `agent-runtime/` — core transport/runtime infra (appendix says `runtime/`; **D-1 retarget**)

| File | imp | test? | Note |
|------|-----|-------|------|
| `workspace-relay-connection.ts`(+test) | 7 (components, shared, shell, terminal) | yes | imports `shared/query/query-client` |
| `workspace-runtime-request.ts`(+test) | 1 (shell) | yes | imports `shell/identity/*`, `shared/query/query-client`. Appendix L448 "rename `resolve-runtime-target.test.ts`" is a **no-op** (file absent, D-2) |
| `workspace-control-routes.ts`(+test) | 16 (agent-runtime, claxedo-ui, components, context, pages, shared, shell) | yes | imports `shell/identity/legacy-resolver`. **Highest-fan-in of the trio.** |

(`runtime-adapters.ts: delete` — **already gone**, D-2.)

### 1e. → `shared/data/` — backend/service transport clients (appendix L511)

| File | imp | test? | Note |
|------|-----|-------|------|
| `api.ts`(+test) | **63** (nearly every dir) | yes | **Largest blast radius in the whole WP.** `import { ... }` base HTTP client. Isolate in its own batch. |
| `convex-client.ts`(+test) | **0 prod** | yes | prod-dead (test-only). Appendix says move; flag for keep-or-delete review. |
| `credential-request.ts`(+test) | 3 (components) | yes | |
| `server.ts` | 1 (context) | no | type-imports `@/context/server`; test gap |
| `server-health.ts`(+test) | 3 (app.tsx, components) | yes | **value-imports `usePlatform` from `@claxedo/context/platform`** — drags a Solid-context hook into `shared/data/`; see §4/§8 design wrinkle |
| `share-workspace.ts`(+test) | 1 (claxedo-ui) | yes | |
| `auth-client.ts` | 6 (agent-runtime, claxedo-ui, index/main, shell) | **no** | **named test gap** (LLD L499). Hardcoded in `architecture/scanners.ts:244` (§5). |

### 1f. → `shared/data/` — session/workspace domain logic (appendix L512)

| File | imp | test? | Note |
|------|-----|-------|------|
| `prompt.ts` | 3 (components, pages) | **no** | **named test gap** (LLD L499). type-imports `@/context/prompt`. |
| `comment-note.ts` | 2 (components, pages) | no | type-imports `@/context/file`; test gap |
| `session-title.ts` | 1 (pages) | no | test gap |
| `session-url.ts`(+test) | 4 (components, extensions, pages) | yes | LLD L68 flags as documented compat/legacy-migration site — keep the label |
| `worktree.ts`(+test) | 8 (claxedo-ui, components, context, session) | yes | imports shell + shared |

### 1g. → `shared/data/` — API product clients (appendix L513)

| File | imp | test? | Note |
|------|-----|-------|------|
| `pages-api.ts`(+test) | 14 (claxedo-ui) | yes | **split into `pages-api.ts` + `arena-api.ts`** (appendix L438). Importer repoint must route each of the 14 to the correct half (Pages CRUD vs Arena swarm). |
| `living-apps-api.ts`(+test) | **0 prod** | yes | prod-dead (test-only). Same keep-or-delete flag as `convex-client`. |

### 1h. → `architecture/` — whole-repo import-boundary audit (appendix L514)

| File | imp | test? | Note |
|------|-----|-------|------|
| `workspace-runtime-route-audit.test.ts` | n/a (test) | — | 193 KB, 26 `utils/` path literals. Rewrite as a `scanners.ts`-style check (WP-02 scanner framework). Test-only ⇒ **no layering-graph impact**. |

### 1i. Retained infra: `test-support/` dir (Wave-0 `mock-api.ts` fixture, LLD L91/L547) — stays.

**Residual utils/ after D3: ~26 files** (1a + retained 1b decisions), all dependency-free
*except* `persist.ts` unless it is rehomed (D-3).

---

## 2. CRITICAL — e2e coordination items (e2e/** is a separate session's territory; do NOT edit it here)

### 2a. Real runtime import that BREAKS on move (compile/run dependency)

- **`e2e/bun/workspace-relay-connection.test.ts:11`** — `} from "../../src/utils/workspace-relay-connection"`.
  When `workspace-relay-connection.ts` moves to `agent-runtime/` (§1d), this import path goes stale
  and the bun e2e test fails to resolve. **This is the one hard coupling.** Coordination options for
  the e2e session: (a) update the import to `../../src/agent-runtime/workspace-relay-connection` in
  lockstep, or (b) D3 leaves a re-export shim at the old utils path until the e2e session lands.
  **Must be sequenced with the e2e owner — do not move the file without their commit.**

### 2b. Stale comment/doc references (won't break compile, but misdirect; hand to e2e session)

These cite `src/utils/<moved-file>:line` inside `//`/`*` comments and become dead pointers after the
move. All are e2e-owned files:

- `api.ts` refs: `core-session-actions.spec.ts:1044`, `live-agent-extensions-materialization.spec.ts:191`,
  `core-cloud-offline-roles.spec.ts:766/771/775`, `live-user-hosted-relay.spec.ts:26`,
  `core-workspace-lifecycle.spec.ts:330`, `core-terminal.spec.ts:183`, `core-settings-auth.spec.ts:1631`,
  `helpers/mock-runtime.ts:220/947`.
- `workspace-relay-connection.ts`: `live-user-hosted-relay.spec.ts:49`, `core-workspace-lifecycle.spec.ts:697`,
  `core-harness-ownership-cloud.spec.ts:152`, `helpers/mock-runtime.ts:158/1266`.
- `workspace-control-routes.ts`: `core-sidebar-tree.spec.ts:28`, `core-boot-deep-links-home.spec.ts:258`,
  `helpers/mock-runtime.ts:979`.
- `workspace-runtime-request.ts`: `core-cloud-offline-roles.spec.ts:761`.
- `auth-client.ts`: `core-cloud-provisioning.spec.ts:299`, `core-settings-auth.spec.ts:38/307/316/318/862/863/872/874`.
- `credential-request.ts`: `core-settings-auth.spec.ts:66`.
- `server-health.ts`: `core-cloud-offline-roles.spec.ts:373`, `core-boot-deep-links-home.spec.ts:41`.
- `share-workspace.ts`: `core-user-hosted-workspace.spec.ts:72`.
- `worktree.ts`: `core-workspace-lifecycle.spec.ts:24/178/550`.

**Do not plan to edit any of the above in WP-D3.** File them as a single coordination hand-off to the
e2e session (comment-drift sweep), separate from the 2a hard break.

---

## 3. Method — layering-cycle check (same as the D1 map)

The guard (`architecture/layering.guard.test.ts`, run with `bun test ... --conditions=browser`) computes
`directoryCycles(appRoot)` via `layering.ts` `directoryCyclesFromEdges` over **production** files only
(`scanners.ts prodSourcePaths` — tests excluded), then asserts `newDirectoryCycles(live, baseline)===[]`
**and** `staleDirectoryCycles===[]` against `architecture/layering-baseline.json`. So the baseline must
equal the live 2-node-cycle set exactly.

**Ground truth established:** on this branch the guard **PASSES (9 pass / 0 fail, 560ms)** — baseline is
currently in sync. Note the resolver's caveats that make grep a *heuristic*, not a substitute, for the
guard: (i) `import type` edges and unresolvable specifiers may not count (e.g. `shared/query/session-list.ts:8`
`import type … claxedo-ui/navigation-islands/session-navigation` does **not** produce a live
`claxedo-ui<->shared` cycle even though 13 claxedo-ui files value-import `shared/`); (ii) only 2-node
cycles are detected (`a->b->c->a` is a stated blind spot). **Therefore the authoritative D3 check is:
run the guard after each batch and diff.** The predictions below are grep-derived risk flags to expect.

---

## 4. Layering-cycle prediction per cluster move

Baseline utils-touching cycles today: `context<->utils`, `shared<->utils`, `shell<->utils`
(`layering-baseline.json:23,26,28`). Destination dirs: `agent-runtime`, `shared`, `architecture`.
`agent-runtime` prod outgoing dirs = `{session, shared, shell, utils}` (grep) — it does **not** import
`context/claxedo-ui/components/pages/terminal`, which is why incoming moves to it are cycle-safe.

| Cluster move | New cycle risk | Reasoning |
|--------------|----------------|-----------|
| **Transport trio → `agent-runtime/`** (§1d) | **NONE expected** | Outgoing dirs of the trio = `{shell, shared}`; `agent-runtime<->shell` and `agent-runtime<->shared` already in baseline (L3,L4). All incoming importer dirs (components, context, pages, claxedo-ui, terminal) are dirs `agent-runtime` does **not** import ⇒ one-way edges only. |
| **Cache accessors → `shared/query/`** (§1c) | context→shared reinforced | `directory-config-cache`/`file-request-cache` imported by context ⇒ `context->shared` value edges created. Not a cycle on its own. |
| **Backend clients + domain → `shared/data/`** (§1e/1f) | **`context<->shared` — most likely NEW cycle; verify** | `context->shared` from context importing moved files (`server`, `worktree`, cache accessors). `shared->context` from moved files importing context — notably **`server-health.ts` value-imports `usePlatform` from `context/platform`**. If both resolve as value edges, `context<->shared` (absent from baseline) is introduced. |
| **`api.ts` → `shared/data/`** (§1e) | low, but re-run guard | 63 importers across nearly all dirs become `X->shared`; `shared` reverse-imports almost nothing, so mostly one-way. Watch `context->shared` reinforcement only. |
| **Product clients → `shared/data/`** (§1g) | none | `pages-api` imported by claxedo-ui only; `shared->claxedo-ui` is type-only (non-counting). `living-apps-api` prod-dead. |
| **route-audit test → `architecture/`** (§1h) | none | test file — excluded from `prodSourcePaths`. |

**Expected baseline delta after D3 (must be applied to `layering-baseline.json`):**
- **ADD** `context<->shared` (new, from the backend-client/context coupling) — *pending guard confirmation*.
- **PRUNE** `shell<->utils`: after moving `auth-client, share-workspace, workspace-control-routes,
  worktree, workspace-runtime-request` out, **zero** remaining utils files import `shell/` (verified) ⇒
  `utils->shell` edge disappears ⇒ cycle goes stale.
- **PRUNE** `shared<->utils`: after the moves, **zero** remaining utils files import `shared/` (verified)
  ⇒ stale.
- **KEEP** `context<->utils`: **`persist.ts` sustains it** (value-imports `context/platform` **and** is
  imported by many context files). It only prunes if `persist.ts` is rehomed (D-3 decision).

---

## 5. Baseline / scanner path-key rename list (item 5)

Grep of `architecture/*.json` + `*.ts` for `utils/` yields exactly these keys to update when files move
(everything else in those files is unrelated):

| File:line | Current key | New key |
|-----------|-------------|---------|
| `query-cache-writers.json:78` | `utils/server-health.ts` | `shared/data/server-health.ts` |
| `query-cache-writers.json:79` | `utils/workspace-relay-connection.ts` | `agent-runtime/workspace-relay-connection.ts` |
| `query-cache-writers.json:80` | `utils/workspace-runtime-request.ts` | `agent-runtime/workspace-runtime-request.ts` |
| `query-cache-writers.json:81` | `utils/worktree.ts` | `shared/data/worktree.ts` |
| `source-text-assertions-baseline.json:19` | `utils/server-health.test.ts` | `shared/data/server-health.test.ts` |
| `source-text-assertions-baseline.json:20` | `utils/session-url.test.ts` | `shared/data/session-url.test.ts` |
| `source-text-assertions-baseline.json:21` | `utils/share-workspace.test.ts` | `shared/data/share-workspace.test.ts` |
| `source-text-assertions-baseline.json:22` | `utils/workspace-control-routes.test.ts` | `agent-runtime/workspace-control-routes.test.ts` |
| `source-text-assertions-baseline.json:23` | `utils/workspace-relay-connection.test.ts` | `agent-runtime/workspace-relay-connection.test.ts` |
| `source-text-assertions-baseline.json:24` | `utils/workspace-runtime-request.test.ts` | `agent-runtime/workspace-runtime-request.test.ts` |
| `source-text-assertions-baseline.json:25` | `utils/workspace-runtime-route-audit.test.ts` | `architecture/<new-scanner-name>` (rewrite) |
| `source-text-assertions-baseline.json:26` | `utils/worktree.test.ts` | `shared/data/worktree.test.ts` |
| `retired-vocabulary-baseline.json:33` | `utils/workspace-runtime-route-audit.test.ts` | `architecture/<new-scanner-name>` |
| `scanners.ts:244` (`isSignedInGateMetric` allowlist) | `"utils/auth-client.ts"` | `"shared/data/auth-client.ts"` |

**No change needed:** `import-graph.ts:21` `["lru_map", "utils/lru-map.ts"]` — `lru-map.ts` **stays** in
utils/ (verify unchanged). `query-cache-writers.json:50` `claxedo-ui/utils/terminal-scoped-cache.ts` is a
**different** dir (claxedo-ui), untouched. `size-baseline`, `orphan-baseline`, `debt-baseline`,
`library-drift-allowlist`, `layering-baseline`, `production-set-interval-allowlist`,
`session-client-reactivity-baseline`, `layout-guard-baseline` — **zero** `utils/` refs.

---

## 6. Ordering batches (each typecheck-green)

Move recipe per file (additive, so the tree compiles between batches): (a) create module at new path,
(b) repoint importers, (c) delete old path, (d) run typecheck. Order by ascending blast radius; isolate
`api.ts`; land tests/baselines/docs last.

- **Batch 0 — prep/no-op:** confirm the D-2 delete cluster is already gone (it is). Delete `utils/index.ts`
  barrel — **already absent**, skip. Net: nothing to do.
- **Batch 1 — cache accessors → `shared/query/`** (§1c): 3 files, ≤2 importers each. Smallest.
- **Batch 2 — transport trio → `agent-runtime/`** (§1d): `workspace-runtime-request` (1) →
  `workspace-relay-connection` (7) → `workspace-control-routes` (16). **Sequence the relay move with the
  e2e owner (item 2a).** Decide `dialog-select-directory-routes.ts` (D-3) here (recommend follow to
  `agent-runtime/`). Update `query-cache-writers.json:79-80` + source-text-assertions in this batch.
- **Batch 3 — backend/domain/product clients → `shared/data/`** *except api*: `convex-client` (0),
  `living-apps-api` (0), `share-workspace` (1), `server` (1), `session-title` (1), `comment-note` (2),
  `credential-request` (3), `server-health` (3), `prompt` (3), `session-url` (4), `auth-client` (6),
  `worktree` (8), `pages-api` (14, **split → pages-api + arena-api**), `usage-limits-api` (follows api,
  1). Update `scanners.ts:244`, `query-cache-writers.json:78,81`, source-text-assertions in this batch.
- **Batch 4 — `api.ts` → `shared/data/`** (§1e): **isolated** (63 importers). Own batch, own typecheck.
- **Batch 5 — route-audit → `architecture/` scanner** (§1h): test-only; rewrite; update
  `retired-vocabulary-baseline.json:33` + source-text-assertions:25.
- **Batch 6 — `shared/query/utils.ts` split** → `sort.ts` (`cmp`) + `provider-list.ts`
  (`normalizeProviderList`) (appendix L436). Repoint importers; note `inventory.ts` re-defines `cmp` (drift
  fix opportunity, appendix L437).
- **Batch 7 — close named test gaps** (LLD L499): add tests for `auth-client`, `prompt`, and the residual
  `scoped-cache`, `server-errors`, `diffs`. (`directory-*-cache`/`file-request-cache`/`server`/
  `comment-note`/`session-title` also lack tests — optional.)
- **Batch 8 — layering-baseline.json + ARCHITECTURE.md:** run the guard, apply the §4 delta
  (add `context<->shared` if confirmed; prune `shell<->utils`, `shared<->utils`; keep/prune
  `context<->utils` per the `persist.ts` decision). Document shared/'s charter (data = wire shapes +
  transport; query = TanStack wrappers) — **`src/ARCHITECTURE.md` already exists** (edit, do not create).

---

## 7. Blast radius + go/no-go verdict

**Blast radius (src/ importer repoints):** dominated by `api.ts` (**63**), then
`workspace-control-routes` (16), `pages-api` (14, plus the split-routing decision), `worktree` (8),
`workspace-relay-connection` (7), `auth-client` (6). Everything else ≤4. Total ~20 files moved out of
utils/, ~26 residual. `api.ts` alone is >40% of the churn — the single riskiest repoint.

**Cross-package coordination:** exactly **one hard e2e break** (item 2a, `e2e/bun/…:11`) plus a
comment-drift sweep (item 2b). e2e/** is another session's territory — D3 must not edit it.

**Design wrinkles to resolve before/inside D3 (not blockers, but decisions):**
1. **`persist.ts`** (D-3) — not dependency-free; either accept it as the lone residual `context<->utils`
   coupling or rehome it. Blocks the clean "slim primitives-only utils/" claim.
2. **`server-health.ts`** value-imports a Solid hook (`usePlatform`) — moving it into `shared/data/`
   drags a `context` dependency into the transport layer and is the prime suspect for the new
   `context<->shared` cycle. Consider extracting the hook use before the move.
3. **`convex-client.ts` / `living-apps-api.ts`** — prod-dead (0 src importers). Appendix says move to
   `shared/data/`; flag for a keep-vs-delete decision instead of a blind move.
4. **`dialog-select-directory-routes.ts` / `usage-limits-api.ts`** (D-3) — unclassified new residents;
   recommend `agent-runtime/` and `shared/data/` respectively.

**Verdict: GO — with preconditions.** The work is well-bounded, additive, and guard-verifiable. No
architectural blocker. Preconditions:
- **P1.** Retarget the transport trio to `agent-runtime/` (D-1); the appendix/LLD word "runtime/" is stale.
- **P2.** Sequence the `workspace-relay-connection` move with the e2e session (item 2a) — shim or lockstep.
- **P3.** Resolve the four §7 design-wrinkle decisions (esp. `persist.ts` and `server-health.ts`) before
  finalizing the slim-utils charter and the baseline delta.
- **P4.** Treat the layering guard as the authority: run `bun test src/architecture/layering.guard.test.ts
  --conditions=browser` after each batch; apply the §4 baseline delta only against its actual output
  (currently green, so any post-move failure is a real regression signal, not baseline drift).
- **P5.** Skip the D-2 no-op steps (deletes, `resolve-runtime-target.test.ts` rename,
  `terminal-websocket-url.ts` move) — those files are already gone.
