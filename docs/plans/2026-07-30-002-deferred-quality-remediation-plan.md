# Deferred code-quality remediation plan

Date: 2026-07-30. Source: `.codex/code-quality/deferred.md`, re-verified item-by-item
against `fix/cf-reliability-remaining-2026-07-30` (5 parallel verification passes,
all claims re-cited at current line numbers). 22 of 23 items still stand; the
claxedo-connections tsconfig/IntegrationFetch cleanup is the one FIXED item.

## Owner decisions (2026-07-30, recorded verbatim intent)

1. **Group engagement is configurable**: per-binding mode `mention` (bot acts only
   when tagged) or `unprompted` (bot may reply untagged, governed by system-prompt
   guidance: "you will be addressed by this name; only reply when someone asks the
   room and you can add value"). Engagement mode is separate from ACCESS: group
   senders must still be individually authorized; access stays deny-by-default.
2. **Pairing must bind to a real Claxedo account**: a paired chat identity is not
   enough; a linking step promotes it to `bound` against an actual Claxedo user.
   Design item (app-settings link flow), not this wave.
3. **Approval buttons are requestee-only**: only the person the AI asked may
   approve, and the agent should state whose answer it is waiting on. Enforce
   actor == requestee; thread `threadKey` through button approvals.
4. **`createTokenService` stays public API**: it is documented in
   `docs/architecture.md:154,206`; add it to the README before first publish.
5. **Fetch timeout**: 10s, injectable, applied uniformly to all five connection
   impls (including `google.ts`, which today hands an unbounded `fetchImpl` to the
   vendored client).
6. **Wakes budgets stay soft ceilings for launch**: document them as advisory.
   Revisit with an atomic count-and-insert port change before anything bills or
   throttles abuse off them.
7. **Session pagination**: proceed to a keyset-pagination `WorkspaceAuthority`
   contract change — plan/spec first, owner reviews before implementation.
8. **Runtime image**: owner will push a new sandbox image and make it latest; bump
   `DEFAULT_WORKSPACE_RUNTIME_VERSION` only after the image exists. NOTE: the
   Vercel driver installs the runtime from npm and npm latest is 0.6.0 while the
   repo is 0.7.0 — the npm publish must land with/before the image push or
   `vercel.ts` version assertion fails the snapshot build.
9. **Daytona `domainAllowList` is mutable post-create** (owner confirmed): reapply
   the egress policy on reuse AND resume.
10. **Vercel brokered-secrets policy must MERGE** (union of create-time allow-list
    and brokered hosts), not replace. The in-code "secure default = replace"
    comment is overruled: replace both breaks granted egress (git/npm mid-run) and
    can silently WIDEN egress when a brokered host wasn't in the create-time list.
11. **Codex auth mirroring → generalize**: store a content hash of what we last
    materialized and detect external-writer drift; this applies to ALL credentials
    collected from a user's machine and materialized into cloud VMs, not just
    Codex. Design item: "materialized credential drift detection + sync".

## Corrections to fold into `.codex/code-quality/deferred.md`

- The always-true secret assertion is in **claxedo-connections**
  (`src/impls/work-source.test.ts:23`), not claxedo-channels. Only :23 is clearly
  always-true; most `service.test.ts` siblings stringify flowing values and are
  falsifiable.
- Credential registry: the SQLite metadata step IS internally transactional
  (`ClaxedoDB.transaction`); the non-atomic boundary is secret-store ↔ metadata.
- `image.ts`: `SANDBOX_IMAGE` has five importers (modal, exe, docker, box + tests),
  and `image.ts` is a published npm subpath (`"./image"` in exports) — removing
  `buildSandboxImage`/`ensureSnapshot` is an API removal, not internal cleanup.
  `SNAPSHOT_NAME` and `SANDBOX_IMAGE_REPOSITORY` are also live.
- Vercel brokered policy: not fail-closed — replace can widen egress; the code
  documents replace as deliberate (`vercel.ts:135-142`). Overruled by decision 10.
- The repo-targeting hole is narrower and sharper than written: signed/hosted mode
  DOES authorize resolved workspaces; the real bugs are
  `channels-control-plane.ts:131` (sender-named repo resolving to NO workspace
  returns `{ok:true}` — fail-open) and `:92` (unsigned mode skips authorization).
- Approval buttons have compensating checks (pending callId, signed-mode authority
  check on the actor), but the threadKey guard at `approval-bridge.ts:41` is
  vacuous because `onApproval` (`command-emit.ts:378-385`) forwards no threadKey.
- Runtime-version pin: the "image tag, not package version" defense is stale —
  since snapshot schema v8 the image build derives its version from
  `workspace-runtime/package.json`; the pin's only production consumer is the
  Vercel npm install. Last OBSERVED live image was built at runtime 0.5.1.
- This branch's new `convex-unbounded-read-guard.test.ts` does NOT cover
  `sessions.list`: its `isBounded` predicate is satisfied by any `.withIndex(`,
  including unbounded index ranges.
- Convex wakes hosted path: budget counts and insert are three separate Convex
  transactions — the check-then-act window is WIDER than SQLite.
- `createTokenService` IS documented (`docs/architecture.md`), just not in README.

## Wave 1 (launched 2026-07-30, parallel agents, no owner decision pending)

### W1 — claxedo-channels access control (launch blocker)
- Every transport sets `chatType` from its own payload: Telegram `msg.chat.type`,
  Baileys `chatId.endsWith("@g.us")`, chat-sdk `guildId`/`teamId`/`channelId`,
  fake passthrough for tests. Group branch in `access.ts` becomes reachable.
- Group engagement config per decision 1: `mention` (default) | `unprompted`.
  Mention-gating implemented for group chats in mention mode (Telegram today does
  not mention-gate at all). Group ACCESS default is deny-by-default (allowlist /
  pairing), never "open".
- Fix `channels-control-plane.ts:131` fail-open: named repo resolving to no
  workspace fails CLOSED.
- Approval buttons per decision 3: thread `threadKey` through `onApproval`;
  enforce actor == requestee; approval prompt states whose answer is awaited.
- Remove `"exclude": ["src/**/*.test.ts"]` from channels tsconfig; fix revealed
  test type errors (measured 2026-07-30: **57**, collapsing to 3 patterns — 43x
  TS2322 from one root cause: handler seams at command-emit.ts:23/:62,
  reply-sink.ts:96, whatsapp-baileys-socket.ts:123 declare `void | Promise<void>`
  returns that reject `Array.push`'s `number`; widen those four production seams
  rather than annotating 43 test sites, per the connections IntegrationFetch
  precedent. Remainder: chat-sdk-render.test.ts collector typing (10x TS2345),
  whatsapp-baileys-socket.test.ts optional-handler invocations (4x TS2722),
  chat-sdk-bridge.test.ts mock return unions (4x TS2322) — test-side fixes).
- DoD: package typecheck + tests green with tests included in typecheck; new tests
  for each transport's chatType, mention gating, the fail-closed branch, and
  requestee-only button approval.

### W2 — claxedo-mcp hardening
- `browser-tools.ts:300` scheme refine (http/https only) + one pass over the other
  browser tool schemas for doc/validator mismatch.
- `workgraph-tools.ts` tenant guard: add assertion that input keys ⊆ the tool's
  declared schema keys (the property actually wanted); keep the denylist as a
  second line, extended with the impersonation-shaped names.
- `server.ts:475` transcript read: resolve and prefix-check the path against the
  workspace directory before `readFile`.
- Remove tsconfig test exclusion; fix the 44 revealed errors (loose test doubles —
  prefer narrowing production seams over annotating tests).
- DoD: package typecheck (tests included) + tests green; probe tests for rejected
  schemes and out-of-workspace transcript paths.

### W3 — workspace-runtime + claxedo-connections small batch
- `routes/session-core.ts:962/:986`: run `sessionOperationGuard` unconditionally
  on the RESOLVED `question.sessionID`, not the optional query param.
- Connections: injectable 10s timeout on all five impls (decision 5), including
  wrapping google's fetch; align `google.ts` to `IntegrationFetch` if feasible.
- `stores/memory.ts` `get()` returns a clone like its siblings; extend the
  aliasing regression test to cover `get()`.
- Always-true assertion pass in connections tests (work-source.test.ts:23 first;
  keep result-carrying assertions).
- README documents `createTokenService` (decision 4).
- DoD: both packages typecheck + tests green; a test proving the guard runs when
  `?sessionId=` is omitted.

### W4 — sandbox-manager
- `image.ts` logger: replace the no-op with an injectable sink defaulting to a
  real console logger (same seam style as `onEgressUnenforced`).
- `runtime-version.ts`: make `workspaceRuntimeVersion()` env-change-safe (drop or
  key the module cache); `vercel.ts:98` must not freeze it at import time.
- Daytona (decision 9): reapply egress policy on reuse and resume via the SDK's
  post-create update; if the SDK genuinely lacks the call, refuse reuse on policy
  mismatch and surface it — do not silently keep the stale policy.
- Vercel (decision 10): merge brokered hosts into the create-time allow-list;
  update the `vercel.ts:135-142` comment; test asserts the original allow-list
  survives brokering.
- DoD: package typecheck + tests green; reuse/resume-with-policy tests exist for
  Daytona; merge test for Vercel.

### W5 — Atlassian site_url coordinated fix (added 2026-07-30 after W3)
- The strict connect-time validator (`impls/atlassian.ts:49` normalizeSiteUrl:
  https-only, `<site>.atlassian.net`, no port) validates but never persists; the
  weaker request-time validator (`workgraph/src/connectors/jira/source-view.ts:81-89`:
  allows http and any host except bare `atlassian.net`) is what gates where Basic
  credentials are sent. Fix in one coordinated pass:
  1. connections: `verify()` returns the normalized origin; the service persists
     the VALIDATED origin, not the raw caller field (VerifyResult contract change,
     all impls + service updated together).
  2. workgraph: jira source-view re-validates with the SAME strict rule
     (normalize + `<site>.atlassian.net` https-only) as defense for rows persisted
     before this fix; invalid stored values are refused with a clear error, never
     silently used.
- DoD: probe test showing a raw `"  https://acme.atlassian.net/wiki/home/  "`
  connect persists `https://acme.atlassian.net`; workgraph test showing an http
  or non-atlassian stored value is refused.

## Deferred to design/spec (not this wave)

- **Session pagination contract** (decision 7): keyset pagination on
  `WorkspaceAuthority`, defining storage-applied filters, cursor + total-count
  semantics; also fix `convex-unbounded-read-guard.test.ts` so bounded means
  bounded. Spec doc for owner review before code.
- **Process stop cannot fail**: typed outcome from `stop`/`stopAll`/`startAll`
  (pattern: `restart()`'s `LaunchResult`), threaded through routes and MCP —
  3-package contract change, own PR.
- **Materialized credential drift detection** (decision 11): content-hash +
  sync design covering codex-auth-file and every collected-from-machine
  credential; supersedes the narrow mtime-check fix.
- **Account linking** (decision 2): app-settings flow that promotes a paired
  chat identity to `bound` against a Claxedo user; unblocks owner notification.
- **Credential registry atomicity / worker-credential CAS / worker telemetry
  waitUntil / discovery per-item outcomes**: storage-protocol-sized; sequence
  after launch-blocking waves.
- **Runtime pin bump** (decision 8): blocked on image push + npm publish of the
  matching runtime version.
- **services.test.ts source-text overfit**: dedicated test-architecture pass.
- **Wakes hard budgets** (decision 6): revisit before budgets back billing.
