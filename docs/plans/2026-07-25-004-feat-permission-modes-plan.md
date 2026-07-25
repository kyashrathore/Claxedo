# Permission modes: one Claxedo Auto + each harness's own modes, wired end to end

- **Date:** 2026-07-25
- **Status:** PLANNED
- **Owner intent:** a permission control that is honest on all eight harnesses — Claxedo ships exactly **one** mode of its own (Auto, the default), and after a harness is selected the user may pick from that harness's **own** modes, in the harness's own words. Never claim a capability a harness does not have.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
- Exact Definition of Done per task; a task without a runnable verification command is not done.
- **No false-positive verification:** green tests are claims. Every suite added here must contain a negative assertion that fails when the feature is broken, and each guard must be **tripwired** (break it on purpose, watch it fail, restore).
- Local-first: replayable locally before any CI wiring.
- Make illegal states unrepresentable: prefer `Record<HarnessId, …>` and discriminated deliveries over string checks.
- Strangler/additive: no behaviour removed until its replacement is green.
- Push parallel agents/workflows for independent tasks; the parallelization map below is normative.

---

## 1. State of the world

**Landed (uncommitted, tests green):**

| Piece | Where |
|---|---|
| Mechanism matrix over all 8 `HarnessId`s | `claxedo-app/src/features/session/permission/mechanisms.ts` |
| One-Auto + harness-modes model, per-harness Auto delivery | `…/permission/modes.ts` (28 tests) |
| Danger-gated allowlist for auto-answer | `…/providers/permission-auto-respond.ts` |
| ACP option fallback chain (was cancelling tool calls) | `agent-sdk-runtime/src/harnesses/acp/permission-options.ts` (14 tests, tripwired) |
| `SessionMode.name/description` preserved (was discarded) | `…/harnesses/acp/session.ts` (6 tests) |
| Claude SDK `PermissionMode` compile-time parity lock | `…/harnesses/claude/permission-mode-parity.ts` (tripwired) |

**Live regression to fix first (W0).** `permission.tsx:154` runs the tier allowlist on every `permission.asked`. For ACP the `permission` field is `toolCall.title` — a display string ("Read file src/index.ts") — so it matches nothing and **"Approve for me" is inert on `claude-acp` / `codex-acp` / `cursor-acp`** (and probably `pi`). Before the allowlist it auto-approved everything there.

**Not built:** selection persistence, any delivery wiring, the picker, the e2e.

## 2. The model (normative)

Auto's *intent* is identical everywhere — approve reads and in-project edits, ask before anything risky — but **delivery differs**, because delegating to a harness that natively implements the intent is strictly better: it is *enforced* (the risky action is never attempted, and it survives Claxedo disconnecting), and Claude's classifier judges a command far better than a fixed allowlist.

| Harness | Auto delivers | Enforced by | Selectable harness modes |
|---|---|---|---|
| `opencode` | config `permission` rules (pattern-scoped, W3) | opencode | none — rules, not modes |
| `claude-sdk` | `permissionMode: "auto"` | Claude | default, acceptEdits, auto, plan, dontAsk, bypassPermissions |
| `codex-app-server` | `approvalPolicy: "on-request"` + `workspace-write` | Codex | untrusted, on-request, read-only, never |
| `claude-acp`/`codex-acp`/`cursor-acp` | Claxedo answers `allow_always` | Claxedo | whatever the agent advertises |
| `cursor-sdk` | Claxedo answers `allow_always` | Claxedo | none — no permission surface exists |
| `pi` | Claxedo answers | Claxedo | none |

Two invariants: (a) an empty harness-mode list **must** carry an `unavailable` reason — a silent empty list is the failure this design exists to prevent; (b) **no silent fallback** — if a delivery fails at runtime, surface an error rather than quietly dropping to local answering, or the user believes a classifier is gating commands when only an allowlist is.

## 3. Explicitly out of scope

- **ACP shell-command classification.** `ToolKind.execute` is one bucket for `ls` and `rm -rf /`, and at permission time the command exists only in unschematised `toolCall.rawInput`. So ACP `execute` **asks**, and the UI says why. Codex solves this with ~3,100 lines of flag-aware Rust (`find -exec`, `git -c`, `rg --pre`, `base64 -o` are each RCE/exfil vectors behind a read-only-looking name); Claude uses a model classifier. We reimplement neither.
- **dcg integration.** Wrong polarity: it is a blocklist (deny known-destructive) and auto-approval needs an allowlist (permit known-safe). "No destructive pattern matched" ≠ safe. Codex keeps `is_safe_command.rs` and `is_dangerous_command.rs` as separate files for exactly this reason. Revisit only as a *blocking* hook.

## 4. Workstreams

### W0 — Stop the regression (ships first, blocks the picker)

- **T0.1** Forward `toolCall.kind` (ACP's closed `ToolKind` union) through `harnesses/acp/process.ts` → `index.ts` → the compat `permissionAsked` event, alongside the existing title. Tier Auto on `ToolKind` for ACP: approve `read`/`search`/`think`/`edit`; ask `execute`/`fetch`/`delete`/`move`/`switch_mode`/`other`.
  - **DoD:** `kind: "read"` auto-approves; `kind: "execute"` and `kind: "delete"` do not; an absent/unknown `kind` asks. Tripwire: stop forwarding `kind` → the read test fails. `bun test src/harnesses/acp` + the app's auto-respond suite green.
  - Note `delete`/`move` stay in the ask tier deliberately — destructive file ops must not ride along with `edit`.
- **T0.2** Decide `pi`'s vocabulary (it parses `permission: <tool>` in-band). Either map its tool names or mark Auto honestly inert for pi. **DoD:** a test asserting the chosen behaviour; no silent no-op.

### W1 — Selection state

- **T1.1** Persist `PermissionSelection` per `scope()` in `panePreferences`, beside model/variant/agent. Default `{kind:"claxedo-auto"}`. **DoD:** selection survives reload for a draft and an existing session; a selection made in one scope does not leak into another.
- **T1.2** Stale-selection handling: `findPermissionModeOption` → `undefined` falls back to Auto **and** tells the user the previous mode is unavailable on this harness. **DoD:** switching `claude-sdk` → `cursor-sdk` with `plan` selected lands on Auto with a visible reason, not a silent reset.

### W2 — Delivery wiring (one task per `PermissionModeDelivery` variant; parallel after W1)

- **T2.1 `opencode-config-rules`** → `client.config.update({ permission })`. Must emit the **complete key universe** every time (`Config.update` deep-merges and `Permission.evaluate` takes the LAST matching rule in key order, so a partial patch lets a stale rule outrank `*`). `config.update` also calls `markInstanceForDisposal` — **the engine restarts**. **DoD:** rules land in `<dir>/config.json`; switching Plan→Auto overrides every previously-denied key; a mode change is refused or warned mid-turn (behaviour to be decided by a probe, then asserted).
- **T2.2 `claude-sdk-permission-mode`** → `options.permissionMode` at query time and `Query.setPermissionMode()` mid-session; pass `allowDangerouslySkipPermissions: true` with `bypassPermissions` (the SDK rejects it otherwise). Check `ModelInfo.supportsAutoMode` before offering `auto`, and honour `disableAutoMode`. **DoD:** the mode reaches the SDK call; `auto` on a non-supporting model shows unavailable instead of failing at turn time.
- **T2.3 `codex-approval-policy`** → replace the hardcoded `approvalPolicy: "on-request"` at `harnesses/codex/driver.ts:166` and `:246` with the selection, paired with its sandbox. **DoD:** `untrusted` reaches `thread/start` and `turn/start` — this hands users Codex's own 3,100-line classifier for free.
- **T2.4 `acp-set-session-mode`** → a dedicated permission-mode channel. Today `session.ts:189` drives `session/set_mode` from `input.agent`, so agent selection and permission mode share one field. **DoD:** setting a permission mode does not change the agent, and vice versa; both round-trip independently.
- **T2.5 `claxedo-auto-answer`** → honour `respondWith: "always"` so the harness **persists** the grant and stops asking (t3code's `selectAutoApprovedPermissionOption` prefers `allow_always` for this reason). **DoD:** a safe permission is answered once, and a second identical request never arrives.

### W3 — opencode pattern-scoped Auto (no shell parsing of ours)

- **T3.1** Curated `bash` pattern allowlist in opencode's **own** vocabulary. The engine already parses with tree-sitter and generalises via `BashArity` (`git checkout main` → `git checkout *`), and `bash` rules are pattern-scoped — so this is a config list, not a classifier.
  - **DoD:** `ls *`, `cat *`, `git status *`, `git log *`, `git diff *`, `pwd *`, `wc *` auto-approve. **Negatives (mandatory):** `rm *` asks; `curl *` asks; `ls && rm -rf /` asks (the AST yields two command nodes, `rm` matches no allow rule); `git push *` asks.

### W4 — Picker UI

- **T4.1** Permission-mode picker in the composer, replacing the binary switch: `Claxedo → Auto`, then `<Harness> → …` with the `unavailable` reason rendered when empty. Uses the shared `claxedo-composer-menu` surface. **DoD:** all eight harnesses render a coherent picker; `cursor-sdk` shows Auto plus its reason and nothing invented.
- **T4.2** Per-item info (the `i` affordance) showing the concrete delivery and `caveat` — e.g. *Claude mode "Accept edits"*, or *Claxedo answers these prompts on your behalf*. **DoD:** every option's info names what it maps to; no option shows an invented label.
- **T4.3** Harness chip moves to **first** position in the context row, and the row renders in existing sessions too (**owner: "no backward compat"** — do not preserve the composer-bar placement). **DoD:** harness picker present on both new-session and existing-session surfaces; locked after first turn as today.
- **T4.4** i18n for all new strings: 16 non-EN locales **and** 17 `size-baseline.json` ceilings (the guard counts `split("\n")`, one more than `wc -l`). **DoD:** `locale-parity.test.ts` and `src/architecture` green.

### W5 — E2E (opencode + claude; owner's pick)

- **T5.1 Hermetic opencode.** Scripted fake model endpoint forces a known tool call. Assert: with Auto **not** applied the permission surfaces; with Auto applied the same call produces **zero** permission requests. **DoD:** runs in default CI, no credentials; contains the negative half (feature broken ⇒ suite red). Reuse the scripted-provider seam from `2026-07-25-003` if landed.
- **T5.2 claude-sdk.** Assert the selected `permissionMode` reaches the SDK invocation and that `bypassPermissions` carries `allowDangerouslySkipPermissions`. **DoD:** wire-level assertion, not a mock of our own code.

### W6 — Anti-rot

- **T6.1** `agent-sdk-runtime/tsconfig.json` excludes `src/**/*.test.ts`, so **that package's tests are never typechecked** — this already produced one guard that asserted nothing. Either include tests in the typecheck (and fix the fallout) or add a guard asserting type-level locks live in production modules. **DoD:** a tripwire proving the chosen mechanism fails when a type lock rots.
- **T6.2** Guard that `PERMISSION_MECHANISMS` covers `HARNESS_IDS` exactly (compile-time today; keep the runtime assertion so a new harness cannot land with an empty picker).

## 5. Parallelization map (normative)

- **Wave 1 (serial, ships alone):** T0.1 → T0.2. The regression is user-visible; nothing else starts until the auto-answer suite is green.
- **Wave 2 (parallel agents, disjoint files):** T1.1 ∥ T1.2 ∥ T3.1 ∥ T6.2.
- **Wave 3 (fan out — one agent per delivery variant, disjoint packages):** T2.1 ∥ T2.2 ∥ T2.3 ∥ T2.4 ∥ T2.5. Each touches a different harness adapter; no shared files.
- **Wave 4:** T4.1 → T4.2 (same component), ∥ T4.3, ∥ T4.4.
- **Wave 5:** T5.1 ∥ T5.2, then T6.1.
- Probes worth running in parallel *before* Wave 3: does an opencode config update kill an in-flight turn (T2.1)? does `supportsAutoMode` appear in our model catalog (T2.2)? what do `claude-acp` / `codex-acp` / `cursor-acp` actually advertise in `availableModes` (T2.4, and it decides whether Cursor's ACP list is usable at all)?

## 6. Risks / honesty notes

- **Engine restart on config write** (T2.1) is the largest unknown; if it kills an in-flight turn the picker must block or warn mid-turn. Probe before building.
- **Cursor's ACP mode ids are unverified.** No live session has been observed; `SessionModeId` is an open `string`, so Cursor may legitimately advertise nothing. That resolves to Auto-only, which is correct — but it means Cursor gets the least from this feature.
- **`claude-sdk` `auto` is conditional three ways**: per-model `supportsAutoMode`, a `disableAutoMode` setting, and an org `org_max_permission: "ask"` ceiling that forces prompts anyway. The caveat text is static today; T2.2 must make at least the model check real.
- **Local answering dies with the client.** Any Claxedo-answered delivery (all ACP, cursor-sdk, pi) does nothing if no client is connected — the agent hangs. This is the strongest argument for the delegating deliveries and should be said in the UI, not just here.
- **`allow_always` scope is the harness's choice.** We do not widen it; whatever granularity the agent attached to its option is what gets persisted.
- **Pre-existing, unrelated:** `claude/driver.test.ts` "static Claude model catalog" expects 3 models and gets 19 — untouched by this work, almost certainly the SDK sitting at 0.3.215.

## 7. Definition of Done (plan-level)

- [ ] **W0** "Approve for me"/Auto demonstrably auto-approves on every harness where it claims to, with a tripwire per harness family. *Progress:* —
- [ ] **W1** Selection persists per scope; a stale selection degrades to Auto **with a visible reason**. *Progress:* —
- [ ] **W2** All five delivery variants reach their target call, asserted at the boundary (not against our own mocks). *Progress:* —
- [ ] **W3** opencode `bash` auto-approves the curated patterns and asks for every listed negative, including `ls && rm -rf /`. *Progress:* —
- [ ] **W4** Picker renders coherently for all 8 harnesses; every option's info names its real mapping; no invented labels; harness chip first in an always-on context row. *Progress:* —
- [ ] **W5** opencode + claude e2e green in default CI, each containing the negative half. *Progress:* —
- [ ] **W6** Type-level locks live where the compiler reads them, tripwire-verified; mechanism/harness coverage guarded. *Progress:* —
- [ ] **Vision gate:** picker screenshotted in both themes, per the no-false-positive-verification bar. *Progress:* —
- [ ] **Honesty gate:** for each of the 8 harnesses, the UI statement about what Auto does matches the code path actually taken. *Progress:* —
