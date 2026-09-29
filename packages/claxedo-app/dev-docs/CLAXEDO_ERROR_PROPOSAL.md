# Claxedo Session Errors — Audit & Implementation Plan

Audit of Claxedo's session failure surfaces against
[`CODEX_ERROR_DESIGN.md`](./CODEX_ERROR_DESIGN.md) (cited as **E§n**), plus the execution plan to
fix them. Written so an executing agent can pick up any single item without further research.

Companion docs (same directory): [`CODEX_TIMELINE_DESIGN.md`](./CODEX_TIMELINE_DESIGN.md) (**D§n**),
[`CLAXEDO_TIMELINE_AUDIT.md`](./CLAXEDO_TIMELINE_AUDIT.md), [`SESSION_TIMELINE_IMPLEMENTATION.md`](./SESSION_TIMELINE_IMPLEMENTATION.md).

Severity: **P0** — the reported bug and its immediate blast radius · **P1** — structural ·
**P2** — polish.

> **Verification note (2026-07-18)**: every load-bearing citation in this doc was adversarially
> re-verified against source. Corrections applied in place: producer stamping is 5-of-7 not 7-of-7
> (§0.2, T3 step 1); the divider component is `MessageDivider` at `message-part.tsx:1882`, not
> "TurnDivider" (C4, T8); `--color-semantic-danger` resolves nowhere (T9 step 1); silent
> re-create-and-replay removed from T6 (open question 4); `/global/health` auth boundary resolved
> (open question 3).

---

## 0. Three corrections to the brief

The research brief's §2 stated its evidence as verified. Three claims did not survive re-checking,
and two of them change the plan materially. Read this section before anything else.

### 0.1 `HarnessReadiness` **does** gate Send — the brief says it does not

The brief states readiness is "consumed **only** to decorate the harness dropdown … It does **not**
gate Send." That is wrong. `composer.tsx:780-787`:

```tsx
submitDisabled={() =>
  harnessPending() ||           // readiness === "polling"        (composer.tsx:181-185)
  harnessSubmitBlocked() ||     // readiness === "error", + model (composer.tsx:186-191)
  toolbarState.modelSubmitBlocked() ||
  roleSubmitBlocked() ||
  booting() ||
  (!stoppable() && blank())
}
```

What *is* true is narrower and more useful: **`"degraded"` is inert.** It is declared in the union
at `harness/selection.ts:9` and is never produced anywhere in `packages/claxedo-app/src`, and never
consumed. The composer is not "fire-and-hope" — it is *gated on a signal that never carries the
degraded state*.

This is a better starting position than the brief assumed: there is an existing gate to extend, not
a new one to invent.

### 0.2 A wire classification already exists on **almost every** error — and the renderer throws it away

The brief implies classification must be built. It already is.
`packages/agent-sdk-runtime/src/first-turn-error.ts` classifies errors server-side, and **five of the
seven** production sites stamp it onto the wire as `error.data.firstTurnErrorClass`:

```ts
export const FIRST_TURN_ERROR_CLASSES = ["credential", "harness", "model", "workspace"] as const
export function firstTurnErrorData(message: string) {
  return { message, firstTurnErrorClass: classifyFirstTurnError(message) }
}
```

The client prefers it (`onboarding/first-turn-recovery.ts:23-24`) and only falls back to local
regexes. **It is discarded for every turn except index 0**, at `message-timeline.data.ts:371`:

```ts
...(firstTurnRecovery ? { recoveryClass: firstTurnRecoveryClass(error) } : {})
```

Deleting that guard is a one-line change that upgrades every post-first-turn error from bare text
to title + description + action. That is why **T1 alone fixes the screenshot**.

**The two sites that do NOT stamp the class** (both hardcode `name:"UnknownError"` but emit a raw
`data: { message }`): the ACP driver's prompt-error path
(`agent-sdk-runtime/src/harnesses/acp/index.ts:1095-1098`) and
`workspace-runtime/src/session/service.ts:356-359`. Errors from these paths reach the client
class-less and fall back to the client's local regexes — which have drifted from the server's
(T3 step 4). Stamping `firstTurnErrorData` at both sites is added to T3's scope; until it lands,
ACP-path errors get a card whose class comes from the weaker client fallback.

### 0.3 Codex does **not** preflight, and it **does** render bare error rows after user bubbles

The brief's framing — "all errors should be preflight of send" — is not what Codex does, and cannot
be what Claxedo does either. Two facts (E§1.1, E§5.2):

- Codex's 19-member composer block cascade contains **zero** account-shaped members. No auth, model,
  quota, or entitlement preflight exists. Quota is learned *reactively* from the failing turn.
- `stream-error` and `system-error` are first-class transcript rows, and a terminal error on an
  empty turn is deliberately **lifted out of the fold** to sit directly under the user bubble.

Codex's actual axis is **actionability**: if there is a concrete next step, hoist it to a
composer-adjacent surface with a CTA; if there is not, leave a quiet transcript row. Proof: the
bio/cyber policy block is only knowable *after* the server reads the prompt, yet it is hoisted —
because "Continue with GPT-5.6 Terra" is a real action. Meanwhile quota appears in *both* places
with a division of labour: **row = what happened to this turn; banner = what to do about it.**

**The owner's underlying objection is still correct**, and this plan honours it — but the mechanism
is different from the one proposed. The objection is *"it makes us believe the user message is sent,
which is wrong."* The honest resolution:

- Where the message genuinely **was** admitted and the agent genuinely **did** fail, keeping the
  bubble is correct and Codex agrees. What is wrong is the *treatment* — a 2px red rail giving a
  failure the same visual weight as the answer (E§2), and a raw `thread not found: <uuid>` as the
  headline.
- Where the failure was knowable and **actionable** before send, the fix is not "preflight
  everything" but "gate Send on the health signal we already have but never surface, and render the
  fix in the slot that already exists."
- Where the session is simply **lost**, the fix is neither — it is to recover or route, and show
  nothing (E§7).

---

## A. The reported bug (P0)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| **A1** | Error copy is never gated by turn index; the `usageLimitExceeded` component is chosen by *plan*, never by position (E§6.4) | `firstTurnRecovery = index === 0` (`message-timeline.data.ts:189`) → turn 1 gets "Restart the harness" + button; turn 5 gets `thread not found: <uuid>` + red rail | **The whole bug.** Delete the guard at `:371`. Nothing in `firstTurnRecoveryClass` is first-turn-specific — it regex-matches 401/harness/model/workspace |
| **A2** | No coloured left rail exists anywhere in the product; error rows declare `tone="muted"` (E§2, E§1.1) | `<Card variant="error">` → `card.css:113` `--card-accent: var(--icon-critical-base) !important` → 2px full-width red rail (`#ed4831` light / `#fc533a` dark) | Direct violation of D§1/D§8. Failure must not outweigh the answer |
| **A3** | Raw protocol text is a hover-gated disclosure on the *transient* row, never the headline (E§3.4) | `unwrapErrorMessage(error.data.message)` **is** the entire row content (`message-timeline.data.ts:363-374`) | Raw text must move below a title, stay reachable, stop being the headline |
| **A4** | `thread not found` is impossible to surface: lazy resume, silent revert to `needs_resume`, hard loss → `navigate('/')` with project preserved (E§7) | `startTurnWithThreadRecovery` retries **once**; a second failure propagates verbatim to the user (`agent-sdk-runtime/src/harnesses/codex/driver.ts:58-69`) | A dead-harness string is reaching the transcript. Recover, or route — never render the uuid |
| **A5** | Classifier is applied where it has information (`willRetry`, `codexErrorInfo`) | `"Stream error"` (the catch-all at `routes/session-core.ts:767`) and `thread not found` both match **none** of the four regexes → both classified `"workspace"`, because `workspace` is simultaneously a real match and the fallback (`first-turn-error.ts:16-17`) | The least informative errors in the system are confidently mislabelled. Needs an explicit `unknown` and a `session` class |

## B. The pre-send surface (P0/P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| **B1** | The state that blocks Send also renders the fix — worktree-restore banner + matching block reason are one feature (E§5.7, E§11 rule 7) | Health data exists (`AgentHarnessAdapterHealth`, incl. `reason:"harness_process_lost"` and per-session `recovery_error`), is computed on every `detail()` call, and reaches exactly one route — `GET /global/health` — **which no client ever calls** | Plumbing, not data modelling. See T4 |
| **B2** | Block reasons are **one priority-ordered cascade producing one string** (E§5.2) | Six independent boolean terms in `submitDisabled` (`composer.tsx:780-787`), none of which can name *why* | Introduce a single `submitBlockReason()` derivation; keep the booleans as its inputs |
| **B3** | Blocked ≠ disabled: button stays clickable, explains refusal on intent via nonce-forced tooltip / modal (E§5.1, E§5.3) | Hard `disabled`; editor also made `contenteditable="false"` while polling (`frame.tsx:234-235`); the 0.45 fade is on the agent-trigger button (`composer.tsx:192,750`), not the editor | A silently dead composer teaches nothing. Adopt the peek + explain-on-intent pattern |
| **B4** | Three above-composer slots, all `empty:hidden`, self-collapsing (E§5.5) | **The slot already exists**: `beforeInput` (`session-composer-region.tsx:296`), rendered above the followup dock and composer, below the permission/question/todo/revert docks | Its only consumer is `StarterPromptChips`, which returns nothing once any turn has been sent — **mutually exclusive by construction**. Zero structural change needed |
| **B5** | Reconnect is a neutral 65%-opacity spinner line sharing one component with "Loading chat…" (E§5.6) | **No UI whatsoever for a dropped SSE stream.** Lifecycle states exist (`stream-sync-lifecycle.ts:15-20,31-37,47-53`), backoff exists, `"reconnecting"`/`"disconnected"` exist in `platform/runtime/connection-placement.ts:6-7` — no renderer found (only consumer is timer logic in `app/integrations/claxedo-events.tsx`) | A dropped stream mid-turn is invisible until `SessionStatusStage` escalates at 20 s / 45 s / 5 min |

## C. Inline failure anatomy (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| **C1** | Failure is a word: `Ran`→`Stopped`, `Approved`→`Denied`; wrapper/icon/colour identical (E§3.1) | `ToolErrorCard` = `Card variant="error"` + red rail + `circle-ban-sign` icon (`session-ui/src/components/tool-error-card.tsx:94,100`) | Restyle onto the muted activity-row language landed in the timeline work |
| **C2** | Exit status lives in a footer at 50% opacity; success gets a ✓, failure gets **no** icon (E§3.2) | Subtitle = text before the first `": "`, else `"Failed"` (`en.ts:149`) | Near-parity in structure; the gap is tone, not information |
| **C3** | Raw detail = hover-gated chevron → `whitespace-pre-wrap` prose at `description-foreground/80` (E§3.4) | Collapsible `CardDescription` + copy `IconButton` when open (`tool-error-card.tsx:135-145,149`) | **Claxedo's is better** — it has the copy button Codex lacks. Keep; only restyle the shell |
| **C4** | Terminal states are centred dividers between hairlines (E§3.6) | `MessageDivider` exists (`message-part.tsx:1882`) but is used **only for compaction** (`:1903`); interrupted is a `data-interrupted` attribute on the text part (`:1992`), not a divider | Route turn-level terminal errors through `MessageDivider`, not a card |
| **C5** | Diagnostics render as ordinary muted rows | `[data-component="diagnostics"]` filled critical block; `getDiagnostics` **silently `.slice(0,3)`** (`message-part.tsx:139-146`) | Mute the fill; surface the truncation ("+N more") rather than hiding it |

## D. Structural debt found in passing (P1/P2)

| # | Issue | Where | Why it matters |
|---|---|---|---|
| **D1** | **Contract mismatch, live bug.** `agent-config-harness-routes.ts:87-116` fetches `/api/wr/health` but types the response as `SandboxHealth` and reads `body.agentType`, `body.acpBinary`, `body.error` — fields only `/global/health` emits. All optional ⇒ no compile error; all silently `undefined` | `claxedo-server/src/routes/agent-config-harness-routes.ts:87-116` vs `workspace-runtime/src/server.ts:376-386` | The route stamps `ready: body.ok ?? false` (`agent-config-harness-routes.ts:111`); the client then derives readiness from `input.data.ready === false` (`store-state.ts:117-121`) — coarse process liveness end to end. **The harness can be `degraded/harness_process_lost` while `/api/wr/health` reports `ok:true`.** This is exactly the hole T4 must close |
| **D2** | The 8-member `AssistantErrorSchema` union is **dead** for all non-`opencode` harnesses | `packages/schema/src/v1/session.ts:385-394` | Every codex/claude/cursor/ACP/Pi error is `name:"UnknownError"` (all 7 sites hardcode it; only 5 also stamp `firstTurnErrorClass`, §0.2). `constructMessageRows` branches on `error?.name === "MessageAbortedError"` (`message-timeline.data.ts:199,201`) — **a branch that can never be taken** on SDK-runtime harnesses. Any design keyed on `error.name` will not work |
| **D3** | Toast `variant="error"` is a **cosmetic no-op** | `packages/ui/src/components/toast.css:76-86` — every variant rule commented out, including `/* &[data-variant="error"] { border-color: var(--color-semantic-danger); } */`. **`--color-semantic-danger` is defined nowhere** — its only occurrence in the repo is inside this comment | 18 call sites across the app pass `variant: "error"` (none under `features/session`); all believe they are styling error toasts. They are not |
| **D4** | `SessionListNotice` ignores its `variant` prop entirely | `rail-sidebar.tsx:113` — class is a constant | `variant="error"` renders identically to `"loading"`. Six error call sites affected |
| **D5** | `card.css:113`'s `!important` silently overrides the inline accent set at `card.tsx:44` | `packages/ui/src/components/card.{tsx,css}` | `--v2-state-fg-danger` on error Cards is dead code. Resolved only when A2 lands |
| **D6** | `ClaxedoSessionRetry`'s `recovering` branch may be unreachable | `claxedo-session-retry.tsx:34` — hardcoded English `"Recovering ACP client..."` | The `Retry` row only exists when `status === "retry"` (`message-timeline.data.ts:351`). **UNVERIFIED** whether `"retry"` and `"recovering"` can coincide |
| **D7** | `readRuntimeHealth()` **confirmed** to have no client consumer | `agent-sdk-runtime/src/harnesses/*/driver.ts`; ACP's is richest (`acp/index.ts:1449-1468`, per-session `recovery_error`) | Confirms the brief. The data is good; only the route is wrong |

---

## 1. Experience goals

| Today | After |
|---|---|
| Turn 5 fails → `thread not found: 019f73fb-…` behind a red rail | Turn 5 fails → same card turn 1 gets: title, description, action button, raw detail one click below |
| A dead harness is only discovered by sending into it | A dead harness is named above the composer *before* you type, with the button that fixes it |
| A failure has the same visual weight as the answer | Failure whispers; the answer speaks (D§1) |
| A dropped SSE stream is invisible for 20 s | A neutral 65%-opacity reconnect line, same voice as "Loading…" |
| `"Stream error"` is confidently labelled a workspace problem | Unknown errors say they are unknown |
| A lost session shows a uuid | A lost session recovers silently, or renders the session-lost card with a "Start a new session" action (T6 — no auto-navigation) |

---

## 2. Design-language constraints

Inherited from `SESSION_TIMELINE_IMPLEMENTATION.md` §2 and re-affirmed here:

1. **Legacy tokens only** (`--text-*`, `--icon-*`, `--border-*`, `--surface-*`). The app never sets
   `data-new-layout`; anything authored in the v2 fork is dead code. Do **not** extend
   `data-new-layout` branches.
2. **Extend `firstTurnRecoveryClass`, do not build a parallel system.** The
   `{title, description, label}` model already works and is already preferred over local regexes.
3. **Colour is a glyph budget, not a chrome budget** (E§11 rule 4). No rails. Warning/critical
   surfaces at most as a 16px icon plus, where genuinely actionable, a low-opacity wash — never a
   2px full-bleed accent.
4. **Raw protocol text must remain reachable** (expandable + copyable) but must never be the
   headline.
5. **No framer-motion.** Measured-pixel height + CSS transition, `.15s`–`.3s`, interruptible
   (feel-rule F3). Peek enter/exit: opacity + `translateY(4px)`, exits softer than enters (F4).
6. **Reactivity gotchas**, both load-bearing for T4/T5:
   - `beforeInput` is a plain `JSX.Element` evaluated **once** at the `session-screen.tsx:1511` call
     site — reactivity must live *inside* the returned component, as `StarterPromptChips` does.
   - Prompt status-meta is written with bare `setQueryData`/`removeQueries` and **no query
     observer**; reads are non-reactive. Any consumer must subscribe via
     `subscribePromptSessionStatusMeta` or it will never re-render.

---

## 3. Build list & backend support matrix

**Legend: ✅ client-only · 🟡 partial (small gap, fix specified) · 🔴 missing (backend work
required).**

| # | Item | Backend | Evidence / gap |
|---|---|---|---|
| T1 | Un-gate recovery card from turn 0 | ✅ | `error.data.firstTurnErrorClass` already stamped by 5 of 7 producers (remaining 2 folded into T3; client fallback covers the gap meanwhile); client already prefers it (`first-turn-recovery.ts:23-24`). Delete one ternary |
| T2 | Kill the red rail; muted error anatomy | ✅ | styling only |
| T3 | Classifier: add `session` + `unknown` | 🟡 | `first-turn-error.ts` is shared server-side; add 1 regex + 1 union member + mirror the union client-side + stamp the 2 producers that skip `firstTurnErrorData` (§0.2). No transport change |
| T4 | Surface harness health → composer peek + block | 🟡 | **Data exists and is well-shaped**; `AgentHarnessAdapterHealth` reaches `GET /global/health` only. Fix the D1 contract mismatch and forward 3 fields through the route the client *already* calls |
| T5 | `submitBlockReason` cascade + explain-on-intent | ✅ | pure client derivation over existing signals |
| T6 | `thread not found` → recover-or-route | 🟡 | `startTurnWithThreadRecovery` exists; needs bounded re-resume + a terminal branch that routes instead of rendering |
| T7 | SSE reconnect line | ✅ | lifecycle states + backoff already exist (`stream-sync-lifecycle.ts`, `claxedo-events-reconnect.ts`); only a renderer is missing |
| T8 | Turn-level terminal → divider | ✅ | `MessageDivider` exists (`message-part.tsx:1882`; compaction-only today) |
| T9 | Fix toast/notice no-ops (D3, D4) | ✅ | uncomment 4 CSS rules; use the `variant` prop |
| T10 | Diagnostics truncation + muting (C5) | ✅ | `getDiagnostics` already computes the full list before slicing |

**Nothing is 🔴.** The three 🟡s are: one shared-package union widening (T3), one route-contract fix
that is independently a live bug (T4), and one bounded-retry policy change (T6).

### 3.1 Scope honesty on "true preflight"

The brief asks whether a client-only fix is sufficient for Class A. It is not, and the gap is
smaller than the brief feared:

- **What genuinely cannot be preflighted:** `thread not found`. The process death is only observable
  by attempting to use it. No endpoint can make this knowable at compose time. **T6 is the answer,
  and it is recovery + routing, not preflight** — the same conclusion Codex reached (E§7).
- **What can be preflighted today with plumbing only:** harness process liveness and degradation.
  `readRuntimeHealth()` already returns `{status:"degraded", reason:"harness_process_lost"}`; ACP's
  implementation additionally reports every session in `status:"recovering"` with its
  `recovery_error`. This is *better* than what the composer needs. The only thing missing is a
  route that carries it — and the route the client already calls
  (`GET /api/claxedo/agent-config/harness`) is *already trying* to read those fields off the wrong
  upstream (D1).
- **What should not be preflighted at all:** credentials and quota. Codex deliberately learns these
  reactively and fails open (401/403/404 → `null`, never → blocked send). A credential probe on
  every compose is cost and latency for a state that changes rarely and fails loudly anyway.

So: **one route fix unlocks the entire actionable Class A.** Say so plainly rather than proposing a
new health endpoint — one exists, it is just not wired to a caller.

---

## Phase 0 — Fix the screenshot

### T1. Un-gate the recovery card from turn 0

**Goal**: every classified turn error renders title + description + action, regardless of position.

**Experience gain**: the reported bug disappears. The fifth turn failing looks exactly like the
first turn failing. This item alone fixes the screenshot (A1).

**Backend**: ✅.

**Files**:
- `packages/claxedo-app/src/features/session/ui/message-timeline.data.ts`
- `packages/claxedo-app/src/features/session/onboarding/first-turn-recovery.ts`
- `packages/claxedo-app/src/features/session/onboarding/first-turn-recovery-card.tsx`
- `packages/claxedo-app/src/features/session/onboarding/first-turn-onboarding.tsx`

**Steps**:
1. In `message-timeline.data.ts:363-373` (guard at `:371`), drop the `firstTurnRecovery ?` guard so
   `recoveryClass` is always attached:
   ```ts
   rows.push(new TimelineRow.Error({
     userMessageID: userMessage.id,
     text: unwrapErrorMessage(…),
     recoveryClass: recoveryClass(error),
   }))
   ```
   Keep the `firstTurnRecovery` parameter — it still drives starter-prompt suppression and the
   first-turn telemetry funnel (`firstTurnOutcome`, `firstTurnFunnelEvents`). Only its use *at this
   call site* goes away. **Verified turn-agnostic downstream**: the renderer mounts the recovery
   card purely on `recoveryClass` presence with no position check
   (`message-timeline.tsx:1566-1586`), and the retry callback is registered on every submit, not
   only the first (`submit-ui-state.ts:93` → `retryLastPrompt`).
2. Rewrite the copy table (§5 below) so no description is position-dependent. Two of the four
   current descriptions (`credential`, `model`) literally say "this first turn"; `harness` and
   `workspace` already say "this turn" and need only a consistency pass.
3. Rename the module's exports away from `firstTurn*` where they are now position-independent:
   `firstTurnRecoveryClass` → `sessionRecoveryClass`, `firstTurnRecovery(kind)` →
   `sessionRecovery(kind)`, `FirstTurnRecoveryClass` → `SessionErrorClass`. Keep
   `shouldShowStarterPrompts` and the funnel helpers under their existing names — those *are*
   first-turn concepts. Update the ~6 import sites.
4. **Verify the action handlers actually do what the labels promise.** They currently do not:
   `first-turn-onboarding.tsx:43-66` opens the AI-connect dialog for `credential` and auto-picks a
   sibling model for `model`, but for `harness` and `workspace` it only calls `retry?.()` — i.e.
   "Restart the harness" merely re-submits the prompt. Either implement a real restart or change the
   label to "Try again" (§7 marks which). **Do not ship a button that lies.**
5. `bun typecheck` from `packages/claxedo-app`.

**Acceptance**:
- A session whose 5th turn fails renders the recovery card, not a bare string.
- The raw message is still present, below the description, and still selectable.
- Starter prompts still appear only on a session with zero sent turns.
- Every action button performs the operation its label names, or is relabelled.

### T2. Kill the red rail — muted error anatomy

**Goal**: one error anatomy across the timeline that obeys D§1 — failure whispers, the answer
speaks.

**Experience gain**: a failed turn stops shouting louder than the assistant's prose. This is the
single highest-leverage visual change (E§2, E§11 rules 1–4).

**Backend**: ✅ (styling only).

**Files**:
- `packages/ui/src/components/card.css` (the `!important` at `:113`, rail at `:39-48`)
- `packages/claxedo-app/src/features/session/onboarding/first-turn-recovery-card.tsx`
- `packages/session-ui/src/components/tool-error-card.tsx`
- `packages/session-ui/src/components/session-turn.css:73-80` (`.error-card` layout; no critical
  fill here) and `:229-232` (legacy `--text-on-critical-base` text colour)
- `packages/session-ui/src/components/message-part.css:1568-1580` (diagnostics — the actual
  critical fill: `--surface-critical-weak` bg + `--border-critical-base`)

**Spec**:

```
┌ (no rail, no fill)
│ ⚠ 16px icon, var(--icon-warning-base)        ← the ONLY colour, glyph-sized
│ Title            --text-strong, 14/medium
│ Description      --text-base, 13/regular
│ ▸ raw detail     --text-weaker, 12/mono, hover-gated chevron, collapsed  [copy]
│ [ Action ]       Button size=small variant=secondary
└ border: 1px solid var(--border-weak-base); border-radius: var(--radius-lg);
  background: transparent;
```

**Steps**:
1. Delete the `&[data-variant="error"] { --card-accent: … !important }` rule at `card.css:113` and
   the matching `warning` rule if present. Resolves D5 as a side effect.
2. Make the `::before` accent rail at `card.css:39-48` opt-in rather than variant-driven — keep it
   available for surfaces that genuinely want it, but no session error surface may set it.
3. Replace `FirstTurnRecoveryCard`'s amber fill
   (`border-border-warning-base bg-surface-warning-base`) with the transparent + hairline spec
   above. Keep `--icon-warning-base` on the glyph only.
4. Give the card a raw-detail disclosure instead of the current single-line `truncate` (which clips
   the detail to one line and loses it). Reuse `ToolErrorCard`'s collapsible + copy affordance —
   it is already better than Codex's, which has no copy button (C3).
5. Restyle `ToolErrorCard`'s shell to the same anatomy. Keep the `circle-ban-sign` icon; drop the
   rail.
6. Mute the diagnostics block: text at `--text-base`, no `--surface-critical-*` fill, severity
   carried by a 16px icon.
7. Confirm light theme: `--icon-warning-active` is `#95671b` light / `#f1b13f` dark, and
   `--icon-critical-base` `#ed4831` / `#fc533a`. Never use raw alpha — always the token names, per
   §2 constraint 1.

**Acceptance**:
- No session error surface paints a rail or a filled background in either theme.
- Colour appears only as a ≤16px glyph.
- Raw protocol text is present, collapsed, expandable, copyable.
- Screenshot the failing-turn state in both themes and confirm the error no longer outweighs
  adjacent assistant prose.

### T3. Classifier: add `session` and `unknown`

**Goal**: stop confidently mislabelling the two least informative errors in the system.

**Experience gain**: `"Stream error"` stops claiming to be a workspace problem; `thread not found`
gets routed to the recovery path that can actually handle it (T6).

**Backend**: 🟡 — shared package, no transport change.

**Files**:
- `packages/agent-sdk-runtime/src/first-turn-error.ts`
- `packages/claxedo-app/src/features/session/onboarding/first-turn-recovery.ts`
- `packages/agent-sdk-runtime/src/harnesses/acp/index.ts:1095-1098`
- `packages/workspace-runtime/src/session/service.ts:356-359`

**Steps**:
1. **Stamp the two unstamped producers** (§0.2): `acp/index.ts:1095-1098` and
   `session/service.ts:356-359` both emit `error: { name: "UnknownError", data: { message } }`
   without calling `firstTurnErrorData`. Route both through `firstTurnErrorData(message)` so every
   production error carries a wire class. Until this lands, ACP-path errors are classified by the
   client's weaker local fallback.
2. Widen the union to
   `["credential", "harness", "model", "workspace", "session", "unknown"] as const`.
3. Add `const session = /(thread not found|session not found|conversation not found|thread_id|no such (thread|session))/i`
   and test it **before** `harness` — `thread not found` currently matches nothing and falls through
   to `workspace`.
4. Split the fallback from the `workspace` match. Today `first-turn-error.ts:15-16` returns
   `"workspace"` both when the workspace regex matches *and* when nothing matches. Make the final
   `return "unknown"`.
5. Mirror both changes in the client's local fallback regexes
   (`first-turn-recovery.ts:26-29`). Note the client set is currently a strict *subset* of the
   server's — it is missing `payment|quota|rate[ _-]?limit` from `credential` and
   `unsupported operation` from `harness`, and has **no** `workspace` regex at all. Bring them into
   sync in the same pass; a single shared exported constant is preferable to two drifting copies.
6. Add copy rows for `session` and `unknown` (§5).
7. Add unit coverage asserting: `"Stream error"` → `unknown`; `"thread not found: <uuid>"` →
   `session`; each existing class still classifies as before (regression guard on the reordering).

**Acceptance**: the two strings above classify correctly; no existing classification changes.

---

## Phase 1 — The pre-send surface

### T4. Surface harness health → composer peek

**Goal**: a degraded or dead harness is named above the composer *before* the user types, with the
action that fixes it — and Send is blocked while it is.

**Experience gain**: the actionable half of Class A stops being discovered by sending into a dead
process. This is Codex's worktree-restore pattern: **the state that blocks Send also renders the
fix** (E§5.7, E§11 rule 7).

**Backend**: 🟡 — one route-contract fix, which is independently a live bug (D1).

**Files**:
- `packages/claxedo-server/src/routes/agent-config-harness-routes.ts:87-116`
- `packages/claxedo-server/src/…/agent-config-harness.ts:82-89` (`SandboxHealth`)
- `packages/workspace-runtime/src/server.ts:376-386` (`runtimeLiveness`)
- `packages/claxedo-app/src/features/session/harness/{selection.ts,store-state.ts}`
- `packages/claxedo-app/src/features/session/ui/composer/session-composer-region.tsx`
- New: `packages/claxedo-app/src/features/session/ui/components/session-health-peek.tsx`
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx:1511`

**Steps**:
1. **Fix the contract mismatch first — it is a real bug regardless of this feature.**
   `agent-config-harness-routes.ts:87-91` fetches the sandbox's `/api/wr/health` and types it as
   `SandboxHealth`, then reads `body.agentType` (`:112,113`), `body.acpBinary` (`:115`) and
   `body.error` (`:116`). `runtimeLiveness` (`server.ts:376-386`) emits **none** of those — only
   `/global/health`'s `runtimeDiagnostics` does. Every field is optional, so it compiles and
   silently yields `undefined`. Choose one:
   - **(a) preferred** — extend `runtimeLiveness` to include `harnessHealth`, `agentType`,
     `acpBinary`, `error`. Small payload, keeps the existing single call.
   - **(b)** — point the fetch at `/global/health`. Larger payload; check that route's auth boundary
     (`server.ts:436-439`) permits the caller before choosing this.
2. Forward `harnessHealth.status` and `harnessHealth.reason` through the response body at
   `agent-config-harness-routes.ts:103-117`.
3. Derive readiness from health, not only liveness. Today the server route stamps
   `ready: body.ok ?? false` (`agent-config-harness-routes.ts:110-111`) and the client derives
   readiness from `input.data.ready === false` (`store-state.ts:117-121`). Map
   `harnessHealth.status === "degraded" | "unavailable"` → `readiness = "degraded"` — **finally
   populating the union member that has existed and been inert at `selection.ts:9` since it was
   written** (§0.1).
4. Build `SessionHealthPeek`. Anatomy — the muted spec from T2, one line, no fill:
   ```
   ⚠  Harness stopped responding      [ Restart harness ]
   ```
   Slot: `beforeInput` (`session-composer-region.tsx:296`). It already sits above the followup dock
   and composer, below the permission/question/todo/revert docks — the correct z-order for a
   passive advisory. Self-collapse when healthy, mirroring Codex's `empty:hidden`.
   **Reactivity**: `beforeInput` is a `JSX.Element` evaluated once at `session-screen.tsx:1511`, so
   the health subscription must live *inside* `SessionHealthPeek` (§2 constraint 6).
5. Compose with starter prompts at the call site. They are mutually exclusive by construction —
   `shouldShowStarterPrompts` requires zero sent turns — but make the precedence explicit rather
   than implicit: health peek wins.
6. Extend `harnessReadyForSubmit` (`selection.ts:66-70`) to return `false` on `"degraded"`. Note it
   currently short-circuits to `true` for `harness === "opencode"`; preserve that.
7. `bun typecheck` from `packages/claxedo-app`.

**Acceptance**:
- Kill the harness process out-of-band → within one poll interval the peek appears and Send blocks.
  **Unverified assumption to check first**: this presumes the harness config route is polled on a
  standing interval during a session, not only fetched at load/harness-switch. Confirm the cadence
  before committing to this criterion; if there is no standing poll, add one (or piggyback on an
  existing heartbeat) as part of this task.
- Restart it → peek self-collapses, Send re-enables, no reload needed.
- A healthy session renders no extra chrome and no layout shift.
- The route now returns non-`undefined` `agentType`/`acpBinary`/`error` (a fix verifiable on its own,
  independent of the UI).

### T5. `submitBlockReason` cascade + explain-on-intent

**Goal**: one priority-ordered derivation naming *why* Send is blocked, and a composer that
explains its refusal instead of going silently dead.

**Experience gain**: "Connect AI", "Restart the harness", "Read-only workspace" become sentences the
user can read at the moment they try to act (E§5.2, E§5.3).

**Backend**: ✅.

**Files**:
- `packages/claxedo-app/src/features/session/composer/composer.tsx:181-191,780-787`
- `packages/claxedo-app/src/features/session/composer/ui/{submit-control.tsx,submit-ui-state.ts,frame.tsx}`
- New: `packages/claxedo-app/src/features/session/composer/submit-block-reason.ts`

**Steps**:
1. Add `submitBlockReason(): SubmitBlockReason | null` as one ordered cascade over the existing
   signals. Proposed order (most specific first) with final copy:

   | Reason | Condition | Copy |
   |---|---|---|
   | `viewer-role` | `roleSubmitBlocked()` | "Read-only workspace (viewer)" |
   | `harness-degraded` | `readiness === "degraded"` (T4) | "The agent stopped responding" |
   | `harness-error` | `readiness === "error" \|\| configError` | "The agent isn't running" |
   | `harness-polling` | `readiness === "polling"` | "Checking the agent…" |
   | `no-model` | `modelSubmitBlocked()`, no valid model | "Choose a model to continue" |
   | `no-credential` | `modelSubmitBlocked()`, no provider | "Connect an AI provider to continue" |
   | `models-loading` | `providerLoading` | "Loading models…" |
   | `booting` | `booting()` | "Starting up…" |
   | `empty` | `!stoppable() && blank()` | "Type a message to get started" |

   Note the copy pattern lifted from E§5.4: actionable reasons are **imperatives with a purpose
   clause** ("Choose a model *to continue*"); non-actionable ones are flat statements ("Checking the
   agent…").
2. Keep `submitDisabled` as-is for genuinely-inert states (`empty`, `booting`, `models-loading`).
   For the *actionable* reasons, follow Codex: **do not disable** — dim to `opacity: 0.5`, keep the
   button clickable, and surface the reason on click (E§5.1).
3. Explain-on-intent: a tooltip on the Send button for short reasons; escalate to the existing
   `beforeInput` peek for anything carrying an action. **Do not add a modal** — Codex's blocked
   dialog is heavier than Claxedo needs, and `beforeInput` already exists. Where the reason has a
   fix (`no-credential`, `harness-degraded`), the peek should carry the button.
4. Stop making the editor `contenteditable="false"` while polling (`frame.tsx:234-235`). (The
   0.45 fade at `composer.tsx:192,750` is on the agent-trigger button, not the editor — leave it.)
   Let the user type into a composer that is briefly not ready; block only the submit. Typing into
   a dead-looking box is worse than typing into a live one that explains itself on Enter.
5. Delete `harnessPending()`/`harnessSubmitBlocked()` once their inputs are folded into the cascade.

**Acceptance**:
- Every blocked state names itself within one interaction.
- No state exists where Send does nothing and says nothing.
- Viewer role still hard-blocks in the handler (`submit-ui-state.ts:78`).

### T6. `thread not found` → recover, or route — never render

**Goal**: a lost session never reaches the transcript as a string.

**Experience gain**: the exact string in the bug report becomes unreachable by construction (A4,
E§7).

**Backend**: 🟡 — bounded retry + one terminal branch.

**Files**:
- `packages/agent-sdk-runtime/src/harnesses/codex/driver.ts:44-69`
- `packages/workspace-runtime/src/routes/session-core.ts:735-773`
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx`

**Steps**:
1. In `startTurnWithThreadRecovery`, make the resume bounded rather than single-shot: attempt
   resume, retry the turn; allow one further resume+retry cycle. On a *second* `thread not found`
   after resume, treat the state as **terminal** (step 2). Today one failure propagates verbatim
   (`driver.ts:58-69` — the second `startTurn()` is unwrapped, so a repeat failure reaches the
   user).
   **Do not silently re-create the thread and replay the prompt.** A fresh thread has none of the
   conversation history the UI still shows; a silently context-free answer rendered under a full
   transcript is the same class of lie this plan removes elsewhere (and contradicts the `session`
   copy "Its history is still here"). If re-create-and-replay is wanted, it must be explicit — see
   open question 4 (§8).
2. On terminal loss, emit a **classified** error (`firstTurnErrorClass: "session"` via T3) whose
   `message` is human copy, not the protocol string. Keep the uuid in `additionalDetails` for the
   raw-detail disclosure — visible on expand, never as the headline (§2 constraint 4).
3. Client: on `recoveryClass === "session"`, render the recovery card with the "Start a new session"
   action (§5). **Do not** auto-navigate the way Codex does (E§7c) — Codex can silently redirect
   because its threads are cheap and project-scoped; a Claxedo session is a workbench pane with
   user-visible state, and yanking it out from under the user is worse than explaining. Offer the
   action; let the user take it.
4. Ensure the outermost catch at `session-core.ts:767` stops flattening everything to the literal
   `"Stream error"` with no cause. At minimum attach the original message to `additionalDetails`.

**Acceptance**:
- Kill the codex app-server mid-session, then send → the turn recovers silently, or renders the
  session-lost card with an action. The uuid appears only under the expanded raw detail.
- `"Stream error"` no longer appears with its cause discarded.

---

## Phase 2 — Transport and terminal states

### T7. SSE reconnect line

**Goal**: a dropped stream is visible immediately, in the quietest possible voice.

**Experience gain**: closes the 20-second blind window where a dead stream is indistinguishable from
a slow agent (B5).

**Backend**: ✅ — states and backoff already exist.

**Files**:
- `packages/claxedo-app/src/app/connection/stream-sync-lifecycle.ts:15-20,31-37,47-53`
- `packages/claxedo-app/src/app/providers/claxedo-events-reconnect.ts:10-11,25-29`
- `packages/claxedo-app/src/app/integrations/claxedo-events.tsx` (the only current consumer of
  `state.lifecycle` — timer logic, no render)
- New: `packages/claxedo-app/src/features/session/ui/components/session-connection-line.tsx`

**Steps**:
1. Expose the lifecycle state as a reactive signal (it is currently console/state only).
2. Render, in `beforeInput` beneath the health peek — verbatim structure from E§5.6:
   ```tsx
   <div role="status" aria-live="polite"
        class="flex items-center justify-center gap-2 px-4 py-1 text-13-regular text-text-weak">
     <Spinner class="size-4" /> Reconnecting…
   </div>
   ```
   `--text-weak`, no border, no background, no colour. Same component/class for "Connecting…" and
   "Reconnecting…" — Codex deliberately makes reconnection *loading's sibling*, not an error.
3. Mount only for `reconnect-scheduled` and `stopped`. Do **not** show it for the first connect of a
   fresh session — that is ordinary startup.
4. Follow Codex on naming: say "Reconnecting…", not "SSE disconnected" or "relay unreachable". The
   transport name is not the user's problem.

**Acceptance**: kill the stream → line appears within one backoff tick, disappears on reconnect. No
layout shift on a healthy session.

### T8. Turn-level terminal states → divider

**Goal**: aborted / refused / overflowed turns render as dividers, not cards (E§3.6, C4).

**Backend**: ✅.

**Files**: `message-timeline.data.ts`, `message-timeline.tsx`,
`packages/session-ui/src/components/message-part.tsx:1882` (`MessageDivider`).

**Steps**:
1. Route the interrupted case through `MessageDivider` (`message-part.tsx:1882` — today used only
   for compaction, `:1903`; interrupted is currently a `data-interrupted` attribute on the text
   part, `:1992`) with "You stopped after {duration}" — matching the existing "Worked for
   {duration}" fold from the timeline work. Note `interrupted` is already detected
   (`message-timeline.data.ts:199`) but on `error.name === "MessageAbortedError"`, which
   **can never fire on SDK-runtime harnesses** (D2). Re-derive it from
   `session.status`/abort state instead, or the branch stays dead.
2. Same treatment for context-overflow and refusal if/when those are classified.

**Acceptance**: aborting a turn renders one hairline divider, visually a peer of the "Worked for"
row, not an error card.

### T9. Fix the cosmetic no-ops (D3, D4)

**Backend**: ✅. Small, independent, verifiable.

1. Restore the variant rules in `packages/ui/src/components/toast.css:76-86` — but **not by
   uncommenting as-is**: the commented error rule references `--color-semantic-danger`, which is
   defined **nowhere** (its only occurrence in the repo is inside that comment). Substitute a real
   legacy token (`--border-critical-base`) per §2 constraint 1, and do the same for the `success`/
   `loading` rules. Scope note: this changes **all** toasts app-wide — there are 18
   `variant: "error"` call sites (bootstrap, sandbox-section, connections, project-actions,
   workspace-recovery, marketplace, browser-pane), none under `features/session`.
2. Make `SessionListNotice` use its `variant` prop for more than `data-testid`
   (`rail-sidebar.tsx:113`), or delete the prop. Six `variant="error"` call sites
   (`rail-sidebar.tsx:1788,1814,2090,2116,2341,2367`) currently render identically to "loading".
3. Pass `variant` at the question-dock failure toast
   (`ui/composer/session-question-dock.tsx:208-211`) and the revert-failure toast, which pass none
   today.

**Acceptance**: an error toast is visually distinguishable from a default toast; a failed session
list load is distinguishable from a loading one.

### T10. Diagnostics: mute the fill, surface the truncation

**Backend**: ✅.

`getDiagnostics` (`message-part.tsx:139-146`) filters to `severity === 1` then **silently
`.slice(0, 3)`**. Per E§11 and the no-silent-caps principle: keep the cap, but render "+N more" when
the pre-slice length exceeds 3 — the full list is already computed one line above. Mute the fill per
T2 step 6.

---

## 4. Which errors move, which stay — the explicit answer

The brief requires this stated plainly.

### Move to the pre-send composer surface (`beforeInput` peek)

**Gating rule**: an error moves to the peek **iff** (a) it is a *standing condition* rather than a
past event — it will still be true on the next send — **and** (b) there is a concrete action that
resolves it.

| Condition | Blocks Send | Action |
|---|---|---|
| Harness degraded / process lost (T4) | yes | Restart harness |
| Harness not running / config error | yes | Restart harness |
| No credential / provider | yes | Connect provider |
| No model selected / model unavailable | yes | Choose model |
| Viewer role | yes | *(none — informational)* |
| Stream reconnecting (T7) | no | *(none — transient)* |

Everything else stays in the transcript. Note the rule deliberately **excludes** quota and
credential *expiry mid-session*: both are learned reactively (E§1.1), and probing for them on every
compose buys latency for a state that fails loudly anyway.

### Stay inline, and in what anatomy

| Class | Anatomy |
|---|---|
| Tool call failed, subagent failed, patch rejected (Class B) | Muted activity row, failure carried by the **verb**; detail in the expanded body with copy. No rail, no fill (T2, C1–C3) |
| Turn error with a class (credential/harness/model/workspace/session) | Recovery card: glyph + title + description + collapsed raw detail + action (T1, T2) |
| Turn error, unclassified | Same card, `unknown` copy, action = "Try again" (T3) |
| Turn aborted / refused / overflowed (Class C) | Centred hairline divider, peer of "Worked for" (T8) |
| Diagnostics | Muted rows, `+N more` when truncated (T10) |
| Transport (Class D) | **Not transcript content.** Reconnect line above the composer (T7) |
| Session lost | Never a raw string. Silent recovery, or the `session` recovery card (T6) |

### What happens to a user message whose turn failed

**It stays, verbatim, unmarked, and is not auto-retried.** Same as Codex (E§8), and correct for the
same reason: the message genuinely *was* admitted and the agent genuinely *did* attempt work. Marking
it "unsent" would be a second lie in the opposite direction.

The owner's objection is answered not by changing the bubble but by:
1. **Preventing the send** for standing, actionable conditions (T4/T5) — so the class of failures
   that felt like a lie mostly stops happening.
2. **Fixing the treatment** for the rest (T1/T2) — a titled card with a real action, not a red rail
   around a uuid.
3. **Removing the uuid entirely** (T6).

Explicitly **not** proposed: marking the bubble failed, making it re-editable, or auto-retrying.
Codex's edit path is a destructive `thread/rollback` and its retry is always manual; there is no
evidence the extra machinery pays for itself, and a re-editable bubble whose turn partially executed
is a correctness hazard.

### Is `index === 0` gating removed?

**Yes — T1, one ternary at `message-timeline.data.ts:371`.** It is replaced by *nothing*: the class
is always attached, because it is present on the wire for 5 of 7 producers (§0.2; T3 stamps the
remaining 2, and the client's local-regex fallback covers them until then). The `firstTurnRecovery`
parameter survives for starter-prompt suppression and the first-turn telemetry funnel, which are
genuinely first-turn concepts.

---

## 5. Final copy table

Replaces the four rows in `first-turn-recovery.ts:6-11`. All new descriptions are
position-independent — of the current ones, `credential` and `model` literally say "this first
turn"; `harness` and `workspace` say "this turn" (§0.2, T1 step 2).

| class | title | description | action label | action |
|---|---|---|---|---|
| `credential` | **Reconnect your AI provider** | The provider rejected the credential for this workspace. | **Reconnect provider** | open AI-connect dialog *(already implemented)* |
| `model` | **Try another model** | The selected model couldn't serve this turn. | **Switch model and retry** | auto-pick sibling + resubmit *(already implemented)* |
| `harness` | **The agent isn't responding** | The agent process stopped or couldn't run this turn. | **Restart agent** | **must implement a real restart** — today this only resubmits |
| `workspace` | **Workspace isn't ready** | The project workspace wasn't available for this turn. | **Retry** | resubmit *(honest label for the existing behaviour)* |
| `session` | **This session was lost** | The agent process no longer has this conversation. Its history is still here. | **Start a new session** | create sibling session in the same workspace |
| `unknown` | **That turn didn't complete** | Something went wrong and no more detail was reported. | **Try again** | resubmit |

Two deliberate copy choices, both from E§5.4 and E§5.6:

- **`harness` and `workspace` labels changed to match reality.** "Restart the harness" and "Retry the
  workspace" both currently resolve to `retry?.()`. Either the label becomes honest ("Retry") or the
  operation becomes real. Marked in the table; do not ship the current mismatch.
- **No internal vocabulary.** Codex says "Reconnecting to ChatGPT…", never "Codex app-server". Say
  "agent", never "harness", "ACP", or "adapter" — those are our words, not the user's. This means the
  `harness` *class* keeps its internal name while its *copy* does not.

---

## 6. Sequencing & effort

| Phase | Items | Effort | Unlocks |
|---|---|---|---|
| **0** | T1, T2, T3 | S / M / S | **Fixes the reported screenshot.** T1 alone is one line + copy |
| **1** | T4, T5, T6 | M / M / M | The actionable pre-send surface; kills the uuid |
| **2** | T7, T8, T9, T10 | S each | Transport visibility, terminal states, no-op fixes |

T1 is genuinely a one-line change plus a copy pass — do it first and independently; it needs none of
the others. T2 is the highest-leverage *visual* change. T4 carries a real backend fix (D1) that is
worth landing on its own merits even if the peek slips.

---

## 7. Global acceptance checklist

Run after each phase:

1. No session error surface paints a rail or filled background, in either theme.
2. Colour appears in a failure state only as a ≤16px glyph.
3. Every error the user can see has either a title + action, or is a deliberately quiet transient
   line — never a bare protocol string as the headline.
4. Raw protocol text is reachable and copyable from every classified error.
5. No action button performs an operation other than the one its label names.
6. No blocked-Send state is silent — each names itself within one interaction.
7. `thread not found` cannot appear in the transcript. Verify by killing the app-server mid-session.
8. A healthy session renders zero additional chrome and no layout shift versus today.
9. `bun typecheck` from `packages/claxedo-app` (never `tsc`, never from repo root). Per
   `reference_claxedo_app_typecheck_workgraph_dist`, run `tsgo -b` directly to isolate real type
   errors from debt-ratchet output.
10. Verified visually, not just by green tests — screenshot the failing-turn state in both themes and
    review it. Green tests are a claim, not evidence.

---

## 8. Open questions for the owner

1. **T6 step 3 — route or explain?** Codex silently redirects home on hard session loss (E§7c). This
   plan proposes explaining with a "Start a new session" action instead, on the grounds that a
   Claxedo session is a workbench pane with user-visible state while a Codex thread is cheap and
   project-scoped. If you would rather match Codex exactly, that is a one-item change.
2. **T5 step 2 — blocked-but-clickable?** Codex never disables for actionable reasons; it dims and
   explains on click. This is a real behavioural change to the composer. Worth confirming before
   implementation, since it touches the most-used control in the app.
3. **T4 step 1 — which route fix?** (a) extend `runtimeLiveness` with four fields, or (b) repoint the
   fetch at `/global/health`. (a) is proposed. **The auth question for (b) is now resolved:**
   `/global/health` is registered *before* the `relayHostAuth` middleware
   (`server.ts:436-441`) — i.e. it is on the unauthenticated side, so (b) is technically permitted.
   But that cuts against (b): widening client reliance on an unauthenticated diagnostics route that
   would then carry harness detail is the wrong direction. (a) stands.
4. **T6 — is re-create-and-replay ever acceptable?** When resume fails permanently, the only way to
   "silently recover" is to create a fresh thread and replay the prompt — but the fresh thread has
   none of the history the transcript still shows, so the agent would answer context-free under a
   UI that implies continuity. This plan says no (T6 step 1) and goes terminal instead, surfacing
   the `session` card. If silent continuity matters more than honesty here, say so explicitly —
   otherwise the terminal card is the default.
