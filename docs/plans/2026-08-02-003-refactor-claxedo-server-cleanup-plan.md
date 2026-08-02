# claxedo-server cleanup: finish the reorg, fix what the review surfaced

Date: 2026-08-02. Follows `2026-08-02-001` (thesis reorg, Waves 0–5 committed
green at 3408 tests) and the three-agent root-file categorization. Every claim
below was verified against the tree this session; re-cite before executing a
later wave — paths move as earlier waves land.

## State at plan time

- Waves 0–5 committed (11 commits, `worktree-claxedo-server-reorg`), suite green.
- **Uncommitted**: the Wave 6 `routes/` split (57 files into 4 families).
  Typechecks, 620/622 pass. Two known defects: a stale sanity assertion in
  `worker.import-graph.test.ts` (already fixed in working tree) and ONE
  unresolved failure — `routes/workspace/index.test.ts` "signed cloud connection
  mints and records a Runtime Access Token lazily": the `sandbox.ensure` spy
  reports 0 calls while call-site instrumentation shows a spy IS called with the
  right args. Two spy instances exist; the lead not yet run down: **something
  reassigns or defaults `svc.sandbox.sandboxManager` between test setup and
  request handling** (grep `sandboxManager =` / `??=`), or the test module is
  instantiated twice under two resolved ids.

## Verification protocol (unchanged, non-negotiable)

Per wave: typecheck → the three sweeps (`vi.mock` resolution,
dirname/join/URL-relative resolution, stale-basename grep) → full suite
(~200s; runner beats the 120s tool timeout) → commit. Guards that were
edited get fault-injected (inject violation, observe RED, revert) — a green
suite after a failed injection proves nothing; check the injection applied.

Known string-path forms that bit this refactor (check ALL on every move):
static/dynamic imports, `vi.mock()`, spawn args, `new URL()`,
`path.resolve/join(import.meta.dirname|__dirname, …)`, `readFileSync` of
source, guard-list literals (`FORBIDDEN_LOCAL` matches path SUBSTRING — dir
moves safe, renames break), governance `module:`/`tests:` strings
(existsSync-checked from `src/governance/` with a `".."` base), and the
inverse hazard: **strings that are not paths** (token subjects, enum values,
URLs, lock filenames) that a bulk rewrite corrupts. Common-word names
(`credentials`, `worker`, `server`, `control-plane`) are homonym-prone.

## Waves

### W7.0 — resolve the routes/ split, commit it

1. Run down the spy failure with the reassignment lead above. Bound the
   effort; if it stays unexplained, bisect by reverting the `routes/workspace/`
   subset only (keep agent-config/opencode-compat/hosted splits) and file the
   workspace split as follow-up.
2. Re-verify the already-fixed sanity assertion, run full suite, commit.

DoD: suite 100% green, routes/ split (whole or reduced) committed.

### W7.1 — de-stutter the five names I created

`workspace/store/store.ts`→`index.ts`, `workspace/supervisor/supervisor.ts`→`index.ts`,
`session/meta/meta.ts`→`index.ts`, `session/harness/harness.ts`→`index.ts`,
`deployments/hosted-node/hosted-node.ts`→`index.ts`. Imports simplify
(`../store/store`→`../store`). `FORBIDDEN_LOCAL` entries
`workspace/store/store` and `workspace/supervisor/supervisor` are RENAMES →
update + fault-inject. `hosted-node.ts` is pinned by package.json
`start:hosted` → update script. Registry `tests:` strings for
`workspace/store/store.test.ts` → update.

### W7.2 — thin out control-plane/ root (85 → ~44)

1. 32 `convex-*.test.ts` → `control-plane/convex-policy/`. They test repo-root
   `convex/` functions (verified: import `../../../../convex/sessions`), so
   only their own relative imports deepen by one. One registry string
   (`convex-sandbox-leases-policy.test.ts`).
2. 9 `http-*.ts` → `control-plane/http/` (`http.ts`→`http/index.ts`).
   `http-protocol` is imported by 4 siblings; external fan-in small.

### W7.3 — root-file homes (the "just not done" group)

- `session-list.ts`→`session/list.ts`; `global-session.ts`(+test)→`session/global.ts`
- `data-dir-owner.ts`(+test)→`lib/`; `process-events.ts`(+test)→`lib/`
- `posthog.ts`→`observability/posthog.ts`
- `pi-credentials.ts`, `pi-provider-catalog.ts`→`adapters/credentials/`
- `asset-imports.d.ts`, `tokentracker-cli.d.ts`→`types/` (zero fixups; tsconfig include is recursive)

### W7.4 — new `src/http/` (generic multi-deployment HTTP infra)

`proxy.ts`(+2 tests), `sandbox-target-fetch.ts`(+test),
`security-headers.ts`(+test), `cors-origins.ts`(+test). Pins: `proxy.ts` +
`sandbox-target-fetch.ts` are governance `module:` entries; architecture.test
reads `../proxy.ts` by literal path; `security-headers.test.ts` has two
root-depth `path.resolve` calls (lines ~190, ~205). All updated in the same
commit. NOT included: `server-workspace-pty-proxy.ts`,
`remote-access-service.ts` (single-consumer glue → W7.5),
`connections-cors.test.ts` (never imports cors-origins; it's a server
integration test → integration home in W7.6).

### W7.5 — deployment glue + workgraph composition layer

1. → `deployments/local/`: `server-workspace-pty-proxy.ts`,
   `server-usage-limits.ts`(+contract test), `remote-access-service.ts`(+test).
   `server-usage-limits` is in FORBIDDEN_LOCAL (substring; keep basename).
2. → `hosts/workgraph/composition/`: `server-workgraph.ts`(+test),
   `workgraph-agent-tools.ts`(+test), `workgraph-session-gateway.ts`,
   `workgraph-session-v2.test.ts`, `workgraph-process-restart.fixture.ts`(+integration test),
   `workgraph-v2-reachability.test.ts`. Pins to update in lockstep:
   architecture.test reads `../server-workgraph.ts` + asserts the literal
   `import("../../workgraph-session-gateway")` string in server.ts (path
   becomes `../../hosts/workgraph/composition/session-gateway` — keep names or
   adjust assertion to match); `workgraph-v2-reachability.test.ts` self-reads
   via dirname (root-relative → rewrite); FORBIDDEN_LOCAL `server-workgraph`
   substring survives the move; restart-fixture pair: fix the
   `cwd: path.join(import.meta.dirname, "..")` depth. Known pre-existing debt:
   `hosts/workgraph/change-doorbell.test.ts` imports UP into server-workgraph —
   becomes a shorter, saner path after this move.

### W7.6 — `src/integration/` + tunnel trio

Move the 7 `*.integration.test.ts` + `server-documents.test.ts` (same shape,
inconsistent name — rename to `documents.integration.test.ts`) +
`connections-cors.test.ts` (rename `cors.integration.test.ts`). Governance
edits required: `control-plane.integration.test.ts` (ownership line ~184) and
`host-primitives.test.ts` (line ~133 — moves too, it's the public-API
composition test). `user-hosted-tunnel.ts`(+2 tests): keep at root — its e2e
test and the .mjs fixtures form one spawn-string-coupled cluster;
NOT worth the churn. The four `.mjs` files stay at root permanently
(5 spawn sites, 2 external locations).

### W7.7 — de-stutter pre-existing names

`control-plane/adapters/convex/convex-*` (15): `convex-authority.ts`→`authority.ts`
etc. — `convex-authority.ts` is a registry `module:`; `convex-authority.test.ts`
in `tests:`. `billing/billing-*` (4): → `store.ts`, `routes.ts`,
`architecture.test.ts` — keep inside `billing/` (name-pinned dir).
`hosts/connections/connections-host.ts`→`index.ts`(+test).

### W7.8 — rename `control-plane/` → `authority/`

The big one. 327 import specifiers / 164 files (mechanical), ~10 governance
strings, and a **per-literal audit of 72 quoted strings**: path-like ones
change; `subject: "control-plane"` (14×, relay token subject, marked SECURITY
in proxy.ts), `"control-plane.owner.json"` (lock filename),
`"control-plane-review"` do NOT. camelCase/snake_case identifiers untouched.
Update `control-plane/README.md` first line to define: authority/ = identity,
authorization, tenancy — the authority layer of the control plane (the
package). Do LAST, alone, on a green tree.

### Deferred — feature excisability (owner decision, not cleanup)

Documents/workgraph cannot be excluded today: `deployments/local/server.ts`
statically imports both, unconditionally. Billing is the working counter-model
(routes inside the feature + a confinement guard test). The fix is a design
change: feature descriptors mounted via lazy `import()` behind flags,
generalizing the existing one-off "WorkGraph out of Control Plane module load"
guard, plus per-feature confinement tests. Needs an owner decision on whether
excisability is a goal; file as its own plan if so. (An exemplar
`routes/documents.ts` → `documents/routes.ts` move is cheap but pointless
without the seam — deferred with it.)

## Order rationale

W7.0 first: everything layers on the routes split. Renames (W7.1, W7.7) are
separate from moves so `git mv` rename detection keeps diffs reviewable.
W7.8 last: largest blast radius, wants a quiet tree.
