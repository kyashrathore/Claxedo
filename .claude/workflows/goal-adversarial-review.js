export const meta = {
  name: 'goal-adversarial-review',
  description: 'Adversarial + code-quality review of docs/plans/goal.md and the app-shell rewrite work',
  phases: [
    { title: 'Investigate', detail: 'parallel adversarial finders, each tries to falsify goal claims' },
    { title: 'Verify', detail: 'adversarially confirm each material finding against source' },
    { title: 'Synthesize', detail: 'consolidate into the final review answering the user questions' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context handed to every finder. Keeps prompts grounded in real paths.
// ---------------------------------------------------------------------------
const REPO = '/Users/yashvardhansingh/test/opencode'
const GOAL = 'docs/plans/goal.md'
const PREAMBLE = `
You are an ADVERSARIAL reviewer of a large app-shell rewrite. Repo root: ${REPO}.
Branch codex/app-shell-identity-seam; the work landed mostly in ONE commit (d1a69b081b),
699 files / ~59k insertions over base 'dev'. The plan/rubric is ${GOAL} (4263 lines) — in it,
EVERY checkbox is marked [x] complete with long self-reported prose evidence. Your job is to
DISTRUST that. Treat each [x] as a claim to be falsified against the actual source.

The rewrite lives in packages/claxedo-app/src/shell/* (116 files, ~10.6k LOC). Subdirs:
identity, data, chat, session, workspace, state, layout, runners, durability, timeline,
contributions, auth. There is also packages/app (upstream OpenCode app, mirrored/modified),
packages/claxedo-app/src/overrides/* (override layer), and claxedo-ui.

North-star claims to test (from goal.md):
- sessionId is the root identity; directory/workspaceId are NOT scope keys; host is explicit/immutable/never-derived.
- One reactive graph: TanStack Query (server data) + Store (app/layout) + AI useChat (conversation).
  "No second createStore mirror, delta store, event reducer, or watchdog should survive."
- Agent-native: ONE command bus + ONE contribution registry; UI/voice/remote/server are peer command sources.
- "Performant and state-machine based": shell/state/* should hold the lifecycle state machines.
- UI parity is a HARD release gate: pixel/behavior identical, additive only.

IMPORTANT leads already found (verify, don't assume):
- All six shell/state/*.ts machines (connection-placement, runner-lifecycle, session-lifecycle,
  stream-sync-lifecycle, tool-sandbox-attach, turn-lifecycle) have ZERO non-test importers and are
  14-42 lines each (161 LOC total). They appear tested-in-isolation but never wired into the runtime.

RULES:
- Read real files. Cite concrete evidence as file:line. Run grep/bash to confirm before claiming.
- Distinguish: (a) claim is FALSE / overstated, (b) confirmed behavior REGRESSION, (c) architectural
  REGRESSION (worse than before), (d) shadow/duplicate/unused/obsolete code, (e) bad test, (f) genuine win.
- Be specific and falsifiable. "Feels off" is useless; "X exists but nothing imports it (grep: 0 hits)" is gold.
- Prefer a few high-confidence, evidence-backed findings over many speculative ones.
- Note genuine WINS too (what is actually better than before) — the synthesis needs both sides.
`

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['charter', 'summary', 'findings', 'wins'],
  properties: {
    charter: { type: 'string', description: 'which charter you covered' },
    summary: { type: 'string', description: '3-6 sentence bottom line for this charter' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'category', 'evidence', 'recommendation'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['claim-false', 'behavior-regression', 'arch-regression', 'shadow-or-dead-code', 'duplicate-code', 'bad-test', 'coverage-gap', 'naming-or-retrofit', 'perf', 'other'],
          },
          goalClaim: { type: 'string', description: 'the goal.md [x] claim this falsifies, or "n/a"' },
          evidence: { type: 'string', description: 'concrete file:line refs + what you found (grep counts, code excerpts)' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    wins: {
      type: 'array',
      description: 'genuine improvements over the prior state, with evidence',
      items: { type: 'string' },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'holdsUp', 'verdict', 'note'],
  properties: {
    title: { type: 'string' },
    holdsUp: { type: 'boolean', description: 'true if the finding survives adversarial scrutiny' },
    verdict: { type: 'string', enum: ['confirmed', 'partly-confirmed', 'refuted', 'cannot-verify'] },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    note: { type: 'string', description: 'what you checked and why it holds/fails, with file:line' },
  },
}

// ---------------------------------------------------------------------------
// Charters — each maps to the user's review questions.
// ---------------------------------------------------------------------------
const CHARTERS = [
  {
    key: 'identity-seam',
    prompt: `CHARTER: Identity seam. Test the Phase-0 + "Required Architecture" identity claims.
Read shell/identity/* (session-ref.ts, route.ts, resolve-workspace-ref.ts, session-view-key.ts).
Verify: (1) Is SessionRef genuinely the root identity, or do directory/workspaceId string-shapes still
drive routing/scoping in practice? grep for base64 dir parsing, 'workspace:ws_', isWorkspaceIdRef,
directory+sessionId composite keys across shell/, overrides/, claxedo-ui/, context/, session/.
(2) Is 'host' truly immutable & never derived? Look for any place host is inferred from string shape.
(3) Does hasBacking(ref) mean real backing, not just workspaceId presence?
The goal prose claims ~44 string-shape sites were eliminated and a "route audit" test pins it — confirm
the audit actually enforces this vs. being a toothless/over-narrow scan. Report any leftover string-shape heuristics.`,
  },
  {
    key: 'reactive-graph',
    prompt: `CHARTER: One reactive data graph. Test the "no second mirror/delta-store/event-reducer/watchdog survives"
and "TanStack Query/Store/AI each have one writer" claims.
Read shell/data/* (queries, mutations, stream-sync, *-event-projector, directory-cache-manager) and the
global-sync override (overrides/context/global-sync/*, context/global-sync.tsx). Verify:
(1) Is there STILL a createStore mirror of server data anywhere (global-sync child-store, etc.)? The goal
says it was deleted — confirm or find the survivor. (2) Does stream-sync.ts truly do a 3-way partition and
do message deltas provably never hit coarse invalidate? (3) Is useChat the SOLE conversation writer, or is
there a parallel approval/message store? (4) Are there shadow re-export "compatibility" shims that just
forward to new modules (dead indirection)? Count them. This is the core architecture bet — be thorough.`,
  },
  {
    key: 'state-machines',
    prompt: `CHARTER: "Performant and STATE-MACHINE based". This is the user's headline question.
Read ALL of shell/state/* and their tests. CONFIRMED LEAD: these 6 machines have zero non-test importers
and are 14-42 lines each. Determine: (a) Are they wired into the actual runtime at all? Trace who would
USE SessionLifecycle/TurnLifecycle/StreamSync/ConnectionPlacement transitions — is the real session/turn/
stream lifecycle still imperative code in session-controller / runtime-gateway / stream handling? (b) Are
the "exhaustive transition tests" (goal claims them) actually exhaustive, or do they test a 20-line pure
function in a vacuum? (c) Does goal.md overclaim "RunnerSelection and RunnerMigration are distinct state
machines" / "StreamSync covers subscribe/live/backoff/recovery" relative to what the code does?
Render a clear verdict: is the system meaningfully state-machine-based, or is this nominal/theater?`,
  },
  {
    key: 'performance',
    prompt: `CHARTER: Performance & reactivity claims. Read shell/timeline/* (virtual-list, virtual-timeline),
the *.vitest render-count tests, and projects/claxedo-perf-harness/*. Verify:
(1) "Chat render cost independent of message count" / "token append does not re-render siblings" — do the
render-count tests actually prove this, or assert something trivial? (2) "Layout toggles keep DOM mounted"
(the memory note says never use <Show> for expensive panels) — is this honored or violated in shell/layout
and overrides? grep for <Show> wrapping heavy panels. (3) The goal's OWN timing evidence admits the perf
target is "at-risk/noisy" (3.49s vs 2.21s reference) and session-switch first-fold still ~55ms vs 30ms
target — quote these self-admitted misses. (4) Did anything get SLOWER? Look for new per-render work,
extra query invalidations, or double-mounting. Is "performant" actually demonstrated or aspirational?`,
  },
  {
    key: 'agent-native',
    prompt: `CHARTER: Agent-native command bus + contribution registry parity. Read shell/contributions/*
(command-bus, registry, first-party-surfaces, legacy-command) and command-bus-provider.
Verify: (1) Is there ONE command bus that UI handlers actually dispatch through, or do most UI actions
still call functions directly while the bus is a parallel unused abstraction? grep for who dispatches
commands vs. direct handler calls. (2) Is the contribution registry actually consumed to render surfaces,
or is it a registry nobody reads? (3) "Server-pushed commands ride the event stream through the same bus" —
is that wired or stubbed? (4) legacy-command.ts — is this a shadow bridge / obsolete adapter?
Judge whether agent-native parity is real or scaffolding.`,
  },
  {
    key: 'routes-auth-durability',
    prompt: `CHARTER: Routes, host placement behavior, auth/RBAC, durability/rehydration.
Read shell/identity/route.ts, shell/auth/* (role, placement, identity-provider), shell/durability/*
(cache-store, projections, rehydrator), shell/runners/*. Verify:
(1) /s/:sessionId and /w/:workspaceId routing + legacy /:dir redirect — actually implemented & registered?
(2) RBAC: does RolePolicy match backend boundaries or is it a client-only guess? Is the rehydrator proving
server-wins-over-cache in a real path or only in an isolated test? (3) rehydrator.ts has NO test file
(cache-store + projections do) — is rehydrator dead/untested? (4) Runner picker "prevents impossible
host/runner combos" — confirmed in code? Report behavior changes vs. the prior app in these areas.`,
  },
  {
    key: 'ui-parity-behavior',
    prompt: `CHARTER: UI parity (HARD release gate) + behavior changes. The goal claims pixel/behavior-identical,
additive-only. Adversarially hunt for BEHAVIOR CHANGES the user must know about. Read the modified upstream
components in git diff (dialog-*, prompt-input, session/*, settings-*, status-popover, titlebar, file-tree)
and overrides/*. Use: git diff dev...HEAD -- packages/app/src/components packages/claxedo-app/src/overrides.
Verify: (1) The goal's OWN evidence admits a mobile composer-overlap bug was found late and a transient
"Select model"/"Model unavailable"/"Loading models" composer states appeared — are these fully fixed or
papered over? (2) Did the composer/model-selection logic change user-visible behavior (e.g. fail-closed
"Model unavailable" where it used to pick a default)? (3) Is "parity" proven by a real baseline or by a
smoke screenshot + hash the team generated themselves? Critique the parity gate's rigor.`,
  },
  {
    key: 'dead-duplicate-code',
    prompt: `CHARTER: Duplicate / parallel / shadow / unused / obsolete code created by this rewrite (explicit user ask).
Sweep packages/claxedo-app/src (shell, overrides, context, claxedo-ui, session, utils) AND packages/app.
Find: (1) compatibility re-export shims (modules that only re-export from a new location) — list them, they
are dead indirection if no external consumer needs them. (2) Parallel implementations of the same concern
in old + new location both still present (e.g. global-sync mirror code that goal says is deleted but isn't).
(3) Unused exports / unimported files in shell/* (cross-check with grep importers). (4) The 'app-local
@claxedo/* compatibility modules' the goal added to packages/app to make typecheck pass — are these a
maintenance shadow? (5) Dead test fixtures / abandoned scenarios. Quantify with grep importer counts.`,
  },
  {
    key: 'test-quality',
    prompt: `CHARTER: Bad tests. The goal leans HEAVILY on tests as evidence (route audits, source-ownership
audits, ownership scans). Adversarially assess test QUALITY across shell/*.test.* and the audit tests
(utils/workspace-runtime-route-audit.test.ts, packages/app source-ownership-audit.test.ts).
Find: (1) "source-scan/audit" tests that grep the codebase for forbidden patterns instead of exercising
behavior — these are brittle and give false confidence; assess how much of the [x] evidence rests on them.
(2) Tautological/weak-assertion tests (assert a pure 20-line function returns its obvious output).
(3) Tests that mock the thing under test, or assert on implementation details. (4) State-machine tests that
prove nothing about the running app (tie back to state-machines charter). Estimate: of the claimed test
evidence, how much is behavioral vs. structural-scan theater?`,
  },
  {
    key: 'integration-coverage',
    prompt: `CHARTER: Are there ENOUGH integration tests to prevent future regressions? (explicit user ask).
The rewrite is 116 shell files of seams + projectors + caches that must compose correctly. Assess:
(1) Inventory integration/e2e tests (vitest.tsx component tests, browser harness scenarios, any cross-module
tests) vs. the surface area. grep for e2e specs, the verify:browser-parity / session-switch-hot-path /
perf-harness scenarios. (2) Identify the riskiest UNCOVERED seams: stream-sync 3-way partition end-to-end,
event-projector → query-cache → useChat composition, durability rehydration on real reload, command-bus
→ contribution-registry render path, host/route resolution. (3) Are integration tests real (drive the app)
or do "browser-use" verifications rely on manual one-off runs documented in prose that won't run in CI?
Give a concrete coverage verdict and the top gaps that will bite future changes.`,
  },
  {
    key: 'retrofit-naming',
    prompt: `CHARTER: Does the code still feel RETROFIT into the upstream app, and does naming make sense? (explicit ask).
Examine the seam between shell/* (new claxedo-first) and packages/app upstream + overrides/*. Assess:
(1) Does shell/* read as a coherent first-class shell, or as a layer bolted onto upstream with lots of
"compatibility", "bridge", "shim", "mirror", "fallback", "legacy" naming? grep those words and count.
(2) Is the @/ and @claxedo/ override aliasing still doing heavy lifting (sign the rewrite didn't actually
take ownership)? (3) Naming coherence: are there confusing parallel names (e.g. both global-sync and
shell/data doing inventory; sessionRef vs session-view-key vs workspace-key)? (4) Did the rewrite achieve
the "one coherent app shell, not a second app beside the app" invariant, or is it two apps now?
Judge how retrofit-y vs. owned it feels, with examples.`,
  },
]

// ---------------------------------------------------------------------------
// Phase 1+2 — investigate, then adversarially verify each material finding.
// Pipeline so verification of an early-finishing charter starts while others run.
// ---------------------------------------------------------------------------
phase('Investigate')
const investigated = await pipeline(
  CHARTERS,
  (c) =>
    agent(`${PREAMBLE}\n\n${c.prompt}`, {
      label: `find:${c.key}`,
      phase: 'Investigate',
      schema: FINDING_SCHEMA,
    }),
  (report, charter) => {
    if (!report) return { charter: charter.key, summary: '(finder failed)', findings: [], wins: [] }
    // Adversarially verify only material findings (high/critical, or claim-false/regression).
    const material = (report.findings || []).filter(
      (f) =>
        f.severity === 'critical' ||
        f.severity === 'high' ||
        f.category === 'claim-false' ||
        f.category === 'behavior-regression' ||
        f.category === 'arch-regression',
    )
    if (!material.length) return { ...report, verified: [] }
    return parallel(
      material.map((f) => () =>
        agent(
          `${PREAMBLE}\n\nADVERSARIAL VERIFY a finding from charter "${charter.key}". Try to REFUTE it.\n` +
            `Finding: ${f.title}\nClaimed category: ${f.category} / severity: ${f.severity}\n` +
            `Evidence given: ${f.evidence}\nGoal claim it falsifies: ${f.goalClaim || 'n/a'}\n\n` +
            `Re-check the cited files yourself. If the evidence is wrong, stale, or the code actually does the ` +
            `right thing, REFUTE it. Only confirm if it genuinely holds. Default to skepticism.`,
          { label: `verify:${charter.key}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ finding: f, verdict: v })),
      ),
    ).then((verified) => ({ ...report, verified: verified.filter(Boolean) }))
  },
)

const reports = investigated.filter(Boolean)

// ---------------------------------------------------------------------------
// Phase 3 — synthesize into the final review, answering the user's questions.
// ---------------------------------------------------------------------------
phase('Synthesize')
const packet = JSON.stringify(reports, null, 2)
const synthesis = await agent(
  `${PREAMBLE}\n\nYou are the LEAD reviewer. Below are JSON reports from ${reports.length} adversarial finder
charters, each with findings and (for material ones) an adversarial verdict (holdsUp / verdict /
correctedSeverity). DISCARD or downgrade findings whose verdict refuted them. Keep confirmed ones.

Write the FINAL review as Markdown answering EXACTLY these user questions, in this order, each as a section:

1. **Behavior changes detected** — concrete user-visible changes vs. the prior app, with file:line.
2. **Architecturally worse things** — where the new design is worse than what existed.
3. **Duplicate / parallel / shadow / unused / obsolete code** created by this rewrite — list with importer counts.
4. **Bad tests** — and how much of the goal's [x] evidence rests on structural-scan/audit theater vs behavior.
5. **Integration test sufficiency** — are there enough to prevent future regressions? Top uncovered seams.
6. **Performant & state-machine based?** — is it actually? Where did the state-machine bet land (note the
   shell/state zero-importer finding if confirmed). What benefits from it; where things got worse.
7. **What is genuinely better than before, and how it helps the future** — be fair; cite real wins.
8. **Retrofit feel & naming** — does it still feel bolted onto upstream; does naming make sense.

Then a final **Verdict & Top 5 Actions** section: an honest overall grade (is this rewrite landing its
north star or self-certifying?) and the 5 highest-leverage fixes.

Rules: lead with the most important/surprising findings. Every claim needs file:line or a grep count.
Separate CONFIRMED issues from SUSPECTED. Call out where goal.md OVERCLAIMS [x] completion vs. reality.
Be direct and adversarial but fair — credit real wins. No filler.

REPORTS JSON:\n${packet}`,
  { label: 'synthesis', phase: 'Synthesize' },
)

return { synthesis, reportCount: reports.length }
