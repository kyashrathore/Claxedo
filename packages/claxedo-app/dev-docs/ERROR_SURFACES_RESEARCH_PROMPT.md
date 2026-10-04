# Research Prompt — Session Error Surfaces: Codex Reverse-Engineering + Proposal

**Give this whole file to the executing agent.** It contains the grounded problem statement,
the evidence already gathered (do not re-derive it), the exact questions to answer, the
reverse-engineering method, and the required deliverable shape.

---

## 0. Your task in one sentence

Reverse-engineer how the **Codex desktop app** classifies, gates, places, and words session
failures; then produce a concrete proposal for how **Claxedo** should do the same — with
particular attention to *when* an error is surfaced relative to the user pressing Send.

You are producing **two documents** (§6). You are **not** implementing anything.

---

## 1. Repo & prior art

- Repo: `/Users/yashvardhansingh/test/opencode`. App: `packages/claxedo-app` (SolidJS).
  Shared rendering: `packages/session-ui`. Primitives: `packages/ui`.
- **Read these first** (same directory as this file; they are the precedent for the
  method and the output format you should match):
  - `CODEX_TIMELINE_DESIGN.md` — a prior reverse-engineering of the Codex timeline,
    produced from minified `app.asar` bundles. Note its rigour: verbatim class strings,
    byte offsets, exact token values, a state machine. **Match this bar.**
  - `CLAXEDO_TIMELINE_AUDIT.md` — the gap-analysis format (P0/P1/P2, "Codex pattern vs
    Claxedo today vs gap"). Your audit half should look like this.
  - `SESSION_TIMELINE_IMPLEMENTATION.md` — the execution-plan format (goal → experience
    gain → backend status → exact files → steps → acceptance). Your proposal half should
    look like this.
- `dev-docs/` is **gitignored** — these are local research artifacts, not shipped docs.

---

## 2. The problem (grounded — this is verified, not speculation)

### 2.1 The trigger

A user sent three messages in a row. Each rendered as a normal user bubble — i.e. the UI
said "sent" — and each was followed by a bare, full-width red-railed row reading:

```
thread not found: 019f73fb-ef5d-7fd0-9011-124481bc6ef0
```

The user's objection, which is the core of this brief:

> "It makes us believe the user message is sent, which is wrong. All errors should be
> preflight of send and surface on a peeking surface above the session composer instead of
> after sending message. Errors related to tool call fail or subagent fail maybe can be
> part of inline messages."

### 2.2 Verified architecture — there is no preflight anywhere

- `POST /session/:id/prompt_async`
  (`packages/session-core/src/routes/session-core.ts:700`) **admits the message and
  returns immediately**, then runs the turn inside a fire-and-forget `(async () => {…})()`.
  The user message is admitted (`promptAdmissions`) *before* the agent turn is attempted.
- Consequently **every** failure — credential, harness process dead, model unavailable,
  workspace not ready — can only surface *after* the message is already in history.
- A health signal exists but is **dead code from the UI's perspective**:
  `readRuntimeHealth()` (`packages/agent-sdk-runtime/src/harnesses/codex/driver.ts`)
  returns `{status:"degraded", reason:"harness_process_lost"}` and has **no consumer** in
  `claxedo-app` or `claxedo-server`.
- `HarnessReadiness` (`"polling" | "ready" | "degraded" | "error"`,
  `features/session/harness/selection.ts:9`) is consumed **only** to decorate the harness
  dropdown (`controls/agent-harness-selector.tsx:181,182,400`). It does **not** gate Send.
- Net: the composer is fire-and-hope. Nothing can refuse a send.

### 2.3 Verified inventory — four different visual languages for failure

| # | Surface | Where | Treatment | Has title? | Has action? |
|---|---|---|---|---|---|
| 1 | **Turn error** | `message-timeline.tsx:1573` → `<Card variant="error">{text}</Card>` | 2px red left rail (`card.css:44-47` `::before`, `--card-accent: --icon-critical-base`) + **raw** text | ✗ | ✗ |
| 2 | **First-turn recovery** | `onboarding/first-turn-recovery-card.tsx` | Warning-filled card, title + description + **button** | ✓ | ✓ |
| 3 | **Tool error** | `session-ui/components/tool-error-card.tsx:94` | Same red rail; collapsible detail + copy | ✓ | ✗ |
| 4 | **Diagnostics** | `message-part.tsx` `[data-component="diagnostics"]` | Filled critical block | label only | ✗ |

Plus: `Retry` row (`ClaxedoSessionRetry`), and dismissed-question plain text.

### 2.4 Verified structural bug — the good error UI is gated to turn 1

```ts
// message-timeline.data.ts — constructMessageRows
firstTurnRecovery = index === 0
...(firstTurnRecovery ? { recoveryClass: firstTurnRecoveryClass(error) } : {})
```

So the **first** turn failing renders "Restart the harness" + an action button; the **fifth**
turn failing renders `thread not found: <uuid>` with a red rail. Same underlying failure,
different treatment, purely because of turn index. Nothing in `firstTurnRecoveryClass`
(`onboarding/first-turn-recovery.ts:21`) is first-turn-specific — it regex-matches
401/harness/model/workspace. The gate looks like scope creep from onboarding work.

Existing classes: `credential | harness | model | workspace`, each already carrying
`{title, description, label}` — a good copy model that is simply under-used.

---

## 3. The taxonomy to reason about (use this framing)

Sort every failure by **when it is knowable** — this is the axis the proposal turns on.

- **Class A — Preflight-knowable (knowable BEFORE send).**
  Credential missing/invalid, no model selected, harness binary absent, harness process
  dead, workspace/relay offline, session thread lost, over quota.
  *These must never be accepted-then-failed.* The user's claim is that these belong on a
  persistent surface **above the composer**, with Send gated — not as a timeline row after
  a bubble has appeared.
- **Class B — Mid-turn, agent-attributable.** Tool call failed, subagent failed, patch
  rejected, diagnostics. These are legitimately part of the transcript (the agent *did*
  work and part of it failed) and can stay inline — the user explicitly allows this.
- **Class C — Terminal/turn-level.** Turn aborted, model refused, context overflow,
  turn timed out.
- **Class D — Infrastructural/transport.** SSE dropped, relay disconnect, server 5xx.
  Often recoverable and arguably not transcript content at all.

Open question you must answer: `thread not found` is *nominally* Class A (the process was
already dead before Send) but is only *discovered* at turn time. What does Codex do with
this shape — probe/heal on focus, gate the composer, or accept-and-recover silently?

---

## 4. What to find in the Codex app (the research half)

### 4.1 Method

`CODEX_TIMELINE_DESIGN.md` was produced from the ChatGPT desktop app's Electron bundles.
`/Applications/ChatGPT.app` **is present on this machine**. Extract and read
`app.asar` → `webview/assets/*` (minified JS/CSS), plus any thread-page CSS. Cross-check
against live session data under `~/.codex/sessions` (rollout JSONL) and, where useful, the
protocol types already vendored in this repo at
`packages/agent-event-runtime/src/harnesses/codex/protocol/**` (e.g. `ClientRequest.ts`
enumerates every app-server method; `ThreadResumeParams.ts` documents thread recovery).

Cite verbatim class strings / identifiers / token values like the prior doc does. If you
cannot verify something, **say so explicitly** rather than inferring — a wrong claim here
costs more than a gap.

### 4.2 Questions to answer

**Placement & timing**
1. Does Codex ever render a bare error row *after* a user bubble, the way we do? Or are
   pre-send failures hoisted to a composer-adjacent surface?
2. Is there a persistent "banner"/"dock"/"peek" region above or around the composer? What
   is its DOM/class signature, its states, and how does it enter/exit?
3. **Does Codex gate Send at all?** Find the composer's disabled/blocked conditions and
   what each maps to (no model, no auth, agent busy, process down, offline).
4. When a turn fails, what happens to the user's message — does it stay in the transcript,
   get marked un-sent/failed, become re-editable, or get auto-retried?

**Classification & copy**
5. Does Codex classify errors into kinds? Find the mapping table (error code/shape →
   title/description/action) and reproduce it.
6. Exact copy for the equivalents of our four classes + session-lost. Is raw protocol text
   ever shown to the user, and if so, where (expandable detail? copy button? never?).
7. Is there always a recovery action? What are the action verbs, and what do they do?

**Visual language**
8. How is a Class-B inline failure (tool/subagent) rendered *inside* the transcript, in the
   muted activity-row language documented in `CODEX_TIMELINE_DESIGN.md` §3.3/§3.4? Exact
   anatomy, icon, tone, and whether colour is used at all at rest.
9. Is colour ever used as *chrome* (rails, fills), or only as a small signal glyph? Give the
   token values.
10. How do transient/infrastructural errors (Class D) differ visually from agent errors —
    are they even in the transcript?

**Recovery**
11. Does Codex detect a dead/lost thread and silently resume (cf. `thread/resume`), and is
    there any user-visible trace when it does?
12. What is retried automatically vs offered as a button vs terminal?

---

## 5. Constraints for the proposal half

- **Design language**: obey `CODEX_TIMELINE_DESIGN.md` §1 and §8 — prose is the product,
  work is muffled, colour appears at the pointer not at rest, depth by dimming. The current
  red rail is a direct violation: it gives a failure the same visual weight as the answer.
- **Token system**: propose against the **legacy** tokens (`--text-*`, `--icon-*`,
  `--border-*`). The app never sets `data-new-layout`; anything authored in the v2 fork is
  dead code. (This was the central decision of `SESSION_TIMELINE_IMPLEMENTATION.md` §2.)
- **Reuse what exists**: `firstTurnRecoveryClass` + the `{title, description, label}` model
  already work — extend and un-gate them rather than inventing a parallel system.
- **Don't hide the truth**: raw protocol text must remain reachable (expandable/copyable)
  for debugging, just not be the headline.
- **Say what's load-bearing**: for each proposal item, state whether it needs backend work
  (e.g. surfacing `readRuntimeHealth()` through the server to the client) vs pure client
  work, in the ✅/🟡/🔴 style of the implementation plan's §3 matrix.
- **Scope honesty**: if making Class A truly preflight requires a health/capability endpoint
  that does not exist, say so plainly and specify it — do not pretend a client-only fix is
  sufficient.

---

## 6. Deliverables

Write both into `packages/claxedo-app/dev-docs/`:

1. **`CODEX_ERROR_DESIGN.md`** — what Codex actually does. Structure it like
   `CODEX_TIMELINE_DESIGN.md`: element inventory, states, exact tokens/classes, the
   error-classification table, the composer gating rules, and a placement decision tree
   (which error kind lands where, and when). Mark every unverifiable claim as such.

2. **`CLAXEDO_ERROR_PROPOSAL.md`** — audit + plan. Audit in the P0/P1/P2 table format of
   `CLAXEDO_TIMELINE_AUDIT.md`; plan in the item format of
   `SESSION_TIMELINE_IMPLEMENTATION.md` (goal → experience gain → backend status → exact
   files → numbered steps → acceptance checks). It must explicitly answer:
   - Which errors move to a **pre-send composer surface**, and what the gating rule is.
   - Which stay **inline**, and in what anatomy.
   - What happens to a **user message whose turn failed** (kept? marked? re-editable?).
   - Whether `index === 0` gating is removed, and what replaces it.
   - The full **error-class → title/description/action** table, in final copy.

Rank the plan so the first item alone visibly fixes the screenshot above.
