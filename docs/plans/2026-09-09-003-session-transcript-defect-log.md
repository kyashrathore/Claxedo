# Session transcript, composer, and navigation defect log

Status: observations, then three verification passes (2026-09-10, -11, -12); the last one reviewed the fixes themselves.

Reported by the user on 2026-09-09 while driving a live session. Each entry names
the canonical owner, the evidence, and whether the behavior is a defect or an
intentional design that a defect makes worse.

## How to read an entry

Every entry leads with **Reported by the user** — their words, verbatim, including
the ones that carry how it felt to hit it — then **Impact**, then the diagnosis.
The report is the requirement; the diagnosis is only my current best explanation
of it and may be wrong. Two entries (D6, D13) have no user report and say so.

Do not let a fix close an entry because the mechanism was addressed. It closes
when the reported experience is gone.

## Verification method

Findings marked **measured** were produced by calling the real
`Timeline.constructMessageRows` from `message-timeline.data.ts` in a temporary
`bun:test` probe (since removed) and printing the resulting row tags. Findings
marked **read** come from reading the implementation only.

## Standing requirement (user, 2026-09-09)

> No matter what happens there should be no content shift when I jump from one
> session to another.

This governs D11 and constrains any fix to D4/D5: switching sessions must not
reorder, reflow, or re-fold anything under the pointer.

---

## Status, 2026-09-10

Closed, each verified in the transcript lab against the three captured sessions
rather than by reading the diff:

| # | Change | Evidence |
|---|---|---|
| D1 | skill row opens and shows its output | click goes from 0 to 1 output region, holding "Launching skill: code-review" |
| D4 | subagent cards exempt from the fold | with the shipped fold on, 8 context groups and 10 tool rows hide; the subagent chips stay |
| D11 | `session.idle` no longer bumps the row | new test fails when the case is put back |
| D23/D27 | a running tool names itself and opens | all three `pending()` guards removed together |
| D18 | an interrupted turn keeps its fold control | control and default separated; a reader can re-collapse |
| D13 | the disabled rich-staging module deleted | its paint cache was write-only; the 8 paint tests still pass |
| D28 | ~~a non-zero exit is no longer a failure~~ | Reopened 2026-09-12: the Claude evidence was wrong and the Codex change was a no-op; see the correction under "D28's matrix" |
| D5 | folding a running turn can be turned off | a Settings row plus all 17 locales |

Two defects were found while measuring and are closed with them:

- **Claude's `Agent` spawns were never recognised as subagents.** The transcript
  knew `task`, `create_subagent` and `mcp__claxedo__create_subagent`; the event
  runtime's `canonicalToolIntent` knew `agent` as well, but the projection never
  puts that intent on the part, so the two sides had drifted. 4 real spawns, 0
  recognised. This is also why D4 looked worse than the log describes: an
  unrecognised spawn is a standalone tool part, so it folds by the ordinary rule.
- **Claude's `ls` had no renderer and no group.** Every listing was a "Called ls"
  row beside the reads it belongs with.

Both came out of a vocabulary matrix — every tool name the harnesses actually
emit, against the renderer registry, the alias table and the four grouping
vocabularies. Exactly two names had no way to render: `ls` and `askuserquestion`.

### D6/D13's pattern reaches the lab itself

Two measuring instruments were wrong in the same way the assertions in D6 and
D13 are wrong, and both hid the defects they were built to show:

- The lab's fold census reported **grouping** as folding — its "rows folded"
  note counted group membership, so it did not move when the fold changed. It
  now measures the fold.
- The lab's fixture builder attaches question answers under
  `part.tool === "question"`, but produces the tool as `askuserquestion`, so the
  guard never fires. Its comment claims all 54 answered calls carry the record;
  all 4 in the fixture carry `metadata: {}`.

### Refuted or refined by measurement

- **D21 is already fixed and survives being broken.** `[data-scrollable]` now
  carries an always-painted thin bar, and its thumb token is genuinely
  theme-aware (`alpha-dark-20` light, `alpha-light-20` dark), so it does not
  vanish in dark mode. `overflow-x: auto` is set, so the long-line half of the
  entry does not reproduce either. The 240px cap itself is untouched — that is
  R2, and it is open.
- **D2 is already fixed at the canonical owner.** The client-presentation
  projection lowercases `toolName` once at `tool-start`, and every other case
  reads the canonicalised name back out, so no path leaks harness casing.
- **D23 has a second path that is not fixed.** The bare verb is also reachable
  when a call is interrupted before its input finished streaming, leaving no
  `command` key at all. That needs an interrupted trace to reproduce.

### D26 measured: the cost is the duplicate, not the animation

The entry reasoned from the animated property and the usage count, and said so
("Not profiled"). Profiling inverts its emphasis. In the transcript lab on a real
captured session, unfolded with a running last turn: **40 `TextShimmer`
instances, 40 duplicated text copies, 1 animation actually running.** Only the
live row is pending, so the N-concurrent-infinite-animations premise does not
hold; what does scale with the transcript is the second copy of the text each
instance renders whether or not it sweeps.

Fixed by mounting the swept copy only while it sweeps — 40 spans and 469
duplicated characters drop to 1 and 8. The technique is deliberately unchanged:
trading the sweep for an opacity pulse would change the look on the strength of
an assumption the measurement refutes.

### D8 does not reproduce

Measured across column widths 900, 700, 560, 460 and 380 px: the subagent chip
row never overflows (`scrollWidth === clientWidth` at every width) and no chip
escapes the column. A sweep for *any* element inside the transcript column whose
box escapes it, excluding elements inside a scroll container, returns empty —
the wide shell output and markdown tables are all contained.

So no subagent surface the lab renders overflows. The card the report describes
is most likely the one D7 names: the one-off right-side split, which is a
different layout mechanism and is not in the lab. Worth re-checking as part of
D7 rather than as a CSS defect of its own.

### D16's new-thread half, located

`sessionViewKey` keys a draft by session id, else by draft id, else by
`workspace:<dir>:draft`. `PromptProvider` takes its `draftId` from the pane's
`surfaceId` (`directory-scope.tsx:398`), so a new thread opened as a draft-session
pane has its own draft — but one opened without a surface id falls to the shared
per-directory key, which every later new thread in that directory then mounts.
That accounts for the "new thread" half of the report.

The submit path does clear the pre-provisioning scope: `capturePromptSubmitScope`
records the mounted identity before the session exists, and `clear()` resets it.
So the "come back to another existing thread" half is still unexplained, and
reproducing it needs an actual send in a real session rather than a fixture.

### D25's cause, located but not fixed

The flap is not in the Thinking row and not in the 80 ms hold — it is the
session status the row reads. `dispatchSessionStatusEvent`
(`store/session-status-dispatcher.ts:137`) writes the status unconditionally,
whatever its source, so a server `idle` that describes the state *before* the
prompt overwrites the optimistic `busy`; the row drops and returns when the real
busy lands. Same two-writer shape as D15.

It is deliberately not fixed by widening `THINKING_HIDE_HOLD_MS`. The gap is a
request round trip, so no hysteresis value is both long enough to cover it and
short enough to drop the row when a turn really ends. A correct fix needs to
distinguish a stale idle from a genuinely instant turn, and neither
`session.idle` nor `message.completed` carries a timestamp or generation to do
it with. `hasPendingPrompt()` is the causal signal, but `submit/pending.ts`
already imports the dispatcher, so reading it there would be circular.

### D28's matrix, and why the fix is not symmetric

Every site that turns a process result into a failure, and what it reads:

| Harness | Site | Authoritative failure signal | Inferred signal |
|---|---|---|---|
| Codex | `codex/adapter.ts:534-549` | — | `exitCode !== 0` |
| Codex | `codex/adapter.ts:744-756` | `completedItem.error`, `mcpFailed` | `exitCode !== 0` when `itemType === "command_execution"` |
| Cursor | `cursor/adapter.ts:352-358` | `status === "error"` | nested `value.exitCode !== 0` |
| Claude | `claude/adapter.ts:220` | `is_error` | — (the SDK folds both into `is_error`) |

Correction (2026-09-12, replacing the 2026-09-10 paragraph that stood here):
the 2026-09-10 pass claimed `is_error` is false on every local bash
`tool_result` and closed D28 on that. Re-measured on 2026-09-12 across the
local Claude Code logs for this repo, `is_error` is true on 594 of 27,172 Bash
results in the first 400 transcripts (a full-corpus count by the reviewer:
1,417 of 80,668), and those results begin with `Exit code N`. Claude Code
therefore does distinguish the two meanings itself: a non-zero exit that is a
normal negative answer gets `is_error: false` plus `returnCodeInterpretation`
("No matches found", "Files differ"); a genuine failure gets `is_error: true`.
The Claude adapter, which reads `is_error`, is right as it stands.

Codex is the opposite: across 16,529 completed command items in 202 local
rollouts, `CommandExecutionStatus` is a pure function of the exit code
(`completed` iff 0, `failed` otherwise), so "keep only Codex's own verdict"
changed nothing on `item/completed`, and the relaxed `process/exited` path
reported every crash (127, 137) as a plain success while no renderer reads
`metadata.codex.exitCode`. Cursor's shell contract was never measured.

Landed on 2026-09-12 instead: `process/exited` fails on a non-zero code again
so Codex's two paths agree; `item/completed` handles `declined` explicitly and
carries `exitCode` on its metadata; Cursor infers failure from `status ===
"error"` or a non-zero nested exit code, with tests on both axes. D28 is
therefore **open for Codex and Cursor** — those harnesses cannot separate "the
tool answered no" from "the tool failed" at the source — and closed by the
harness's own design for Claude. The honest next step is D22's other half:
render the exit code on a completed shell row.

### R1 is blocked behind its precondition

Aliasing `askuserquestion` onto the `question` renderer *alone* is a regression:
that renderer gates its entire body on `completed()`, which reads
`metadata.answers`, and nothing populates that on the Claude path — so the answer
text the generic row shows today would disappear. The Claude driver writes the
answers into the tool's `updatedInput`, but whether that reaches the part was not
established, so the alias is deliberately not applied yet.

---

## Status, 2026-09-11

Full re-verification. Method: code inspection at each named owner, the focused
unit tests (`directory-event-projector.test.ts`, `turn-fold.test.ts`,
`part-groups.test.ts`, `basic-tool.test.ts` — all green), and live reproduction
in Storybook — the transcript lab on the three captured sessions, and the
timeline playground fed a fabricated `opencode export` fixture built to exercise
each defect state (running calls, an interrupted turn, an answered question
among work, a lone skill row, a 60-line output, a tool error).

| # | Defect | Status | Evidence |
|---|--------|--------|----------|
| D1 | skill row dead click | Fixed | Renderer spreads `{...props}` and renders `props.output` in a scrollable region; clicking "Playwriter" in the playground opens the output |
| D2 | capitalised tool names never group | Fixed | `canonicalToolName` canonicalises once at the contract boundary (`Agent`→`task`, `LS`→`list`); the matrix spec now asserts the real behavior |
| D3 | `skill` splits a work run | Fixed | `isWorkGroupTool` is named by exclusion — `skill`, `sendmessage`, `toolsearch` all join work runs |
| D4 | fold swallows subagent cards | Fixed | `agents` groups and standalone spawns are non-foldable; the chip stays visible under the collapsed fold in the lab |
| D5 | running-turn fold, no off switch | Fixed | Settings → General row + all locales; consumed at `message-timeline.tsx` |
| D6 | can't-fail spec | Fixed | Spec rewritten with a distinguishing assertion against the GenericTool title |
| D7 | subagent opens one-off right split | Fixed | `openSubagent` routes through `workspacePanel.open`; `splitContent` has no transcript caller left |
| D8 | subagent card overflows column | Never reproduced | Log's own measurement stands; lab chips render contained |
| D9 | videos can't be pasted | Still present | `attachmentMime` unchanged — video sniffs binary → dropped with the generic toast. Feature gap, not a filter bug |
| D10 | send mid-turn aborts instead of steer | Still present | `admitPromptSubmission` returns `abort-active` before the text is considered; no caller passes `delivery` |
| D11 | session jumps to top on click | Fixed, redesigned | `session.idle` no longer bumps the row and the rail requests `created_desc`, so a row never moves; the hold-while-aiming and the banded list were built and then deleted (28a3aacb33). See the 2026-09-12 status for what that leaves behind |
| D12 | blocks keep growing after paint | Still present | `markdown-progressive.ts` unchanged: 8 initial rows, +4/frame after 260 ms |
| D13 | dead rich-staging module | Fixed | Module deleted |
| D14 | assistant text emitted twice | Still present | Branch-4 fallback unchanged — a non-continuation snapshot re-emits the whole text; child messages always emit the full snapshot |
| D15 | resolved question flashes on nav-back | Still present | "Absent means keep" + `mergeBusySessionStatus` help, but a stale *defined* question list still re-seeds the cache |
| D16 | composer images leak across threads | Still present | `attachments.ts` and `browser-panel.tsx` still `prompt.set()` on the ambient scope; new threads still share the per-directory draft |
| D17 | late abort kills wrong turn | Still present | `session.abort({sessionID, directory})` carries no turn id |
| D18 | interrupted turn loses fold control | Fixed | `explainsItself` keeps the control and defaults the turn unfolded; verified live — an interrupted turn renders "Worked for 5s" expanded |
| D19 | session switch shifts content | Still present | Cold-mount `renderOverscan` is still 1 and the fold still resolves from post-mount data |
| D20 | blank regions on fast scroll | Still present | `overscan: 50` still dead; effective band still 1–6 rows |
| D21 | hidden scrollbar / silent clip | Fixed | `[data-scrollable]` has an always-painted thin bar; `.ui-bash-scroll` keeps the hover-reveal thin bar. The 240px cap itself is R2 |
| D22 | aborted/failed card too heavy | Fixed | Card is hairline + transparent + dimmed accent; verified live |
| D23/D27 | bare "Running" row, unclickable | Fixed, one residual | A running row names its command and toggles open/closed on click — verified live. **Residual:** a call whose input never landed still renders the bare verb; needs an interrupted trace |
| D24 | expanded card survives fold | Fixed | `foldedGroupKeys` exempts the live group only on auto-fold; an explicit fold hides it |
| D25 | "Thinking…" flaps on send | Still present | The dispatcher still writes server `idle` unconditionally; `hasPendingPrompt` is never consulted outside `submit/` |
| D26 | TextShimmer repaints per instance | Fixed | The swept copy mounts only while sweeping — measured 2 swept vs 6 base spans with two running rows, 0 swept at rest |
| D28 | non-zero exit = tool error | Reopened 2026-09-12 | Claude already separates the two meanings (`is_error` + `returnCodeInterpretation`); Codex's status equals its exit code, so the harness cannot; see the 2026-09-12 correction |
| D29 | opening a panel switches to another | Still present | `workspacePanelTopLevelOpenTarget` unchanged — still forces `focus: review` and `navigator ?? "files"` |
| D30 | localhost URL not openable / tab vanishes | Still present | Transcript anchors are raw `<a target="_blank">`; nothing routes to `openBrowserTab`/`platform.openLink`. The vanish half rides on D29 |
| D31 | only `http(s)` linkified | Still present | Both patterns still hardcode `https?` (`markdown.tsx`, `message-part.tsx`) |
| D32 | subagent chips → phantom rows, dead "Thinking" tabs, unclickable chip | Still present | Confirmed by end-to-end code trace (10 findings): child lifecycle events never publish, task-only rows poison the child buffer, ambient tasks mint phantom rows, ambiguous association forks rows, batched results double-spawn, no terminal sweep at turn end |
| R1 | question should persist as its own card | Still present | `question` sits in `STANDALONE_TOOLS` but is still foldable as a standalone part — the answered question lands inside the turn fold (verified live), and it still uses `BasicTool` chrome |
| R2 | show complete tool output | Still present | `max-height: 240px` untouched; measured `clientHeight 240` vs `scrollHeight 1512` |

Tally: 18 closed, 14 still present, 1 never reproduced. The open cluster that
hurts most is the interactive loop — D10 → D17 → D25 (send aborts, a late abort
kills the next turn, the status row flaps) — plus the ambient-state leaks
D15/D16/D29/D30, and the D32 subagent pipeline, which is the largest confirmed
source of dead UI.

### Found while reproducing

`timeline-playground.stories.tsx` could not render at all: `USER_VARIANTS` calls
`partIds()` at module scope before `const SESSION_ID` initializes — a TDZ crash
introduced in 4cc48881ad. Fixed by moving the `SESSION_ID` declaration above its
first caller (declaration order only, no behavior change).

---

## Status, 2026-09-12

Third pass, with a different question: not "is the mechanism addressed" but
"is the code that addressed it sound". Every fix-wave commit (15e8437dc5 …
8ae58af004) went through a design review against CLAUDE.md, with each claim
re-verified at the owner; the working tree was then fixed where the review
held. Gates at the end of this section.

### Rows that changed status

| # | Was | Now | Why |
|---|---|---|---|
| D2 | Fixed | Fixed, one regression repaired | `askuserquestion → question` routed Claude questions to a renderer gated on `metadata.answers`, which the Claude adapter never set (the R1 note above predicted it). The adapter now reconstructs the answers from `tool_use_result.answers`; `reconstructQuestionAnswers` moved to the contract as the one owner. `multiedit → edit` had the same shape (an empty diff) and is removed from the alias table |
| D3 | Fixed | Fixed, one regression repaired | naming work by exclusion admitted every tool into a run, but the run's header only counted shell/edit/web members, so two skills or two MCP calls read "Worked" with a terminal icon. `work-group-summary.ts` now names the other members |
| D11 | Fixed | Fixed, redesigned; residue | the rail requests `created_desc`, so a row never moves. The banded list, the hold-while-aiming, the `last_human_turn_at` column, its migration and the server `band` filter were built for this and then deleted or orphaned — see "Left for the owner" |
| D16 | Still present | Fixed (writer half) | an attachment resolved the draft after its file read finished, so a switch mid-read put the image in the next session. `add()` pins the composer's scope before the read. The shared per-directory draft is now a per-provider draft id; no production composer mounted without a surface id, so that half was latent |
| D23/D27 | Fixed | Fixed, one regression repaired | a running row's chevron opened an empty panel for every renderer that gates its body on `output`; `hasChildren` now asks whether anything resolved |
| D25 | Still present | Fixed | the stale idle was a `/session/status` read that omits idle sessions, written by the rail batch and the pane hydration through `applyDirectorySessionMeta`. A server idle for a session with a prompt still in flight is ignored; the registry moved to a leaf module so the dispatcher can read it |
| D28 | Fixed | Reopened | see the correction under "D28's matrix" |
| D29 | Still present | Fixed | the top-level open and the full-width seed both had no term for the surface the user chose; `workspacePanelChosenSurface` reads the panel's working set |
| D30/D31 | Still present | Fixed, two residuals | every transcript anchor dispatches `claxedo:open-link`; the app routes loopback to a Browser tab, `file://` to the OS path opener, the rest to `platform.openLink`; both linkifiers share one scheme list; the sanitizer keeps DOMPurify's default schemes plus the app's. Residuals: a bare non-http URL in prose is still marked's autolink (http/www only), and the desktop `open-link` gate still drops `claxedo://` and `vscode://` — a security-policy call, not widened here |
| D32 | Still present | Mostly fixed | findings 2, 4, 5, 6, 7, 8 confirmed by red tests and fixed; 3's cause confirmed but its remedy already existed; 9 and 10 fall out of the phantom producers going away. Open: a completed non-agent background task still mints one terminal row, because `task_notification` carries no agent marker — needs a per-turn task ledger in the Claude driver |
| R1 | Still present | Half done | an answered question is exempt from the fold and no longer counts toward it; it still uses `BasicTool` chrome |

Found in the review and fixed in the same pass: a docked subagent tab hid the
permission and question docks (the read-only gate removed the whole composer
region), so a blocked subagent could never be answered; a rejected delegation
rendered as an empty chip row instead of an error card; the e2e suite still
targeted the deleted task card, and two absence checks were green for any
input; four `ui.basicTool.*` keys existed in English only; `TextShimmer` had
lost its fade-in; eighteen lint errors from the fix wave.

### Left for the owner

These are product or policy calls the fix wave made on its own, or debt it
left, and none is changed here:

- **The session list no longer knows recency.** Each section shows its five
  newest-created sessions; a session created last month and used ten minutes
  ago is not in that page, and an agent-spawned session lands at the top and
  shifts every row. The `last_human_turn_at` column (migration
  `20260910000100`), three `created_at` indexes, the server `band` filter and
  the app's `lastHumanTurn` plumbing survive with no reader, and the control
  plane's sync path never writes the column. Either wire the column and order
  by it, or delete it with a migration.
- **The abort path was rewritten inside 4cc48881ad** with no mention: the
  optimistic idle and the todo clear on Stop are gone, the signed-control-plane
  branch is gone (every abort now calls `session.status`, `permission.list`,
  `question.list`), and failures toast instead of being swallowed.
- **Tool attachments render only in the `read` renderer**; Codex, Pi and
  every other Claude tool's images are computed, persisted and dropped. Also:
  a multi-image result shares one `sourcePath` and loses its bytes, and
  `/file/raw` serves `application/octet-stream`.
- **`transcript-lab-fixture.json` is 1.27 MB of the owner's own transcripts**
  with the home path in it 896 times; the generator has no redaction and the
  storybook workflow builds it.
- The `final-message` fold shape is reachable only from the storybook lab.
- D24's auto-fold half: a card the reader expanded stays open in the live
  group while the control reads folded.
- `timelineFoldWhileRunning` still defaults on; D5 added a switch only.
- The chip replaced the card without its cmd/middle-click anchor; subagent
  tabs live in the workspace-scoped working set and outlive their session;
  their label freezes at first click; there is no narrow-viewport behaviour.
- Commits 455ba55814 … eae253dfd5 do not build in isolation (`canonicalToolName`
  landed nine commits after its first import); they are pushed.
- Several e2e mocks hardcode `sort: "updated_desc"` and
  `core-claude-native-sdk-rail.spec.ts` still asserts the row moving to the top.

### Gates, 2026-09-12

Run on the working tree, which also held another session's uncommitted
models-settings refactor; failures are attributed by file.

| Gate | Result |
|---|---|
| root `bun run lint` | 161 errors, down from 194; none in a file this pass touched (the 18 from the fix wave and the 11 dead identifiers in `message-part.tsx` are gone; the rest predate 2026-09-10) |
| `bun run test:architecture-ratchets` | passes at a clean checkout of the branch head (app-local 1010 / 38, desktop-renderer-unsigned 1061 / 57, ceilings recorded to those numbers) |
| claxedo-app `bun run test:architecture` | 252 pass |
| claxedo-app `tsgo -b`, claxedo-desktop, session-ui, ui, agent-* typechecks | clean |
| session-ui / ui / agent-runtime-contract / agent-event-runtime | 255 / 61 / 40 / 208 pass, 0 fail |
| agent-sdk-runtime | 660 pass; 2 pre-existing failures (the churn ratchet on `runtime.ts` and `codex/driver.ts`, both over their ceiling at the previous head; the Pi catalog test) |
| workspace-runtime | 1108 pass; 10 pre-existing failures (5 SDK-boundary guards that need the `rg` shim, 2 real-pty spawns, 3 directory-less session routes red at the previous head) |
| claxedo-server-core (vitest) | 579 pass; 3 files failed to load a stale local `agent-event-runtime` dist and pass (60 tests) once the contract and event runtime are rebuilt in publish order |
| claxedo-app `bun test` | 5501 pass; 3 pre-existing failures (route audit, two git-client cases) |
| claxedo-app `vitest` | 1384 pass; 2 pre-existing failures (icon sprite id from 12e21d992e, hosted workspace chip) |
| e2e `core-harness-rendering-matrix.spec.ts` | 30 pass under Playwright; the two real-harness specs were updated but not run |

## D1 — The `skill` tool row is a dead click target

**Reported by the user:**

> clicking on skill does nothing.

**Impact:** A row that looks clickable and answers with nothing. The user cannot tell whether the click missed, the app is stuck, or there was never anything to show.

Owner: `packages/session-ui/src/components/message-part.tsx:3150`.

```tsx
return <BasicTool icon="brain" status={props.status} trigger={trigger()} hideDetails />
```

Every other renderer (`read` :2196, `grep` :2292, `bash` :2558) does
`<BasicTool {...props} …>{output}</BasicTool>`. This one differs three ways:

1. `hideDetails` is hardcoded; `basic-tool.tsx:323` gates `Collapsible.Content` on
   `hasChildren() && !props.hideDetails`.
2. No `{...props}` spread and no `props.output`, so `hasChildren()`
   (`basic-tool.tsx:108`) is false and `basic-tool.tsx:292` also suppresses the
   chevron. The skill's output is discarded — the storybook fixture at
   `timeline-playground.stories.tsx:437` supplies
   `output: "Skill loaded successfully"` that never renders.
3. No `onTriggerClick` / `triggerHref` / `clickable`. `webfetch` (:2337) and `task`
   (:2521) are also `hideDetails` but attach navigation instead.

The row is still a Kobalte `Collapsible.Trigger` — a real `<button>`, focusable,
with a hover brighten (`basic-tool.css:390`) and focus background
(`collapsible.css:57`). A click reaches `handleOpenChange` (`basic-tool.tsx:211`)
and flips `state.open` onto nothing. A dead toggle, not a missing handler.

Collateral: `startedAt` (no live elapsed), `defaultOpen`, and the timeline's
controlled `open`/`onOpenChange` are dropped, so per-part open persistence
(`message-timeline.tsx:677`) is ignored for skills.

Read.

## D2 — Claude-harness tool names never group (case mismatch)

**Reported by the user:**

> command ran are not grouped properly, see i can expand and see calls in acordion below "working", i hve to clickon working toggle to see list of commands.
> why so? is this expected?

**Impact:** Every command is a separate loud row, and reaching any of them costs an extra click. The user had to ask whether this was intentional — the transcript gave no way to tell a design decision from a bug.

Owner: the lowercase-only sets in `message-timeline.data.ts:458-470`.

```ts
const contextGroupTools = new Set(["read", "glob", "grep", "list", "read_file"])
const workGroupTools    = new Set(["bash", "command", "shell", …])
const hiddenTools       = new Set(["todowrite"])
```

`packages/agent-event-runtime/src/harnesses/claude/adapter.ts:249` copies the SDK
tool name verbatim, and the native Claude SDK capitalizes: `Bash`, `Read`,
`Skill`, `Task`. The fixture confirms it — `e2e/fixtures/harness-traces/claude-sdk.json`
contains exactly one tool name, `"Grep"`, where `opencode.json` has
`bash`/`read`/`skill`.

The renderer registry survives because `getTool` lowercases
(`message-part.tsx:1794`). The grouping pass does not, and neither does
`isSubagentToolPart` (`subagent-presentation.ts:51`, `part.tool === "task"`), so
`Task` never becomes a subagent chip either.

Measured:

```
lowercase bash x3             -> [ "work" ]                       one accordion
lowercase read x3             -> [ "context" ]
CAPITAL  Bash x3              -> [ "part", "part", "part" ]       three loud rows
CAPITAL  Read x3              -> [ "part", "part", "part" ]
CAPITAL  Bash,Read,Skill,Task -> [ "part", "part", "part", "part" ]
```

Fix direction: normalize once at the harness adapter boundary so every consumer
agrees, rather than adding capitalized aliases to each set.

## D3 — `skill` splits a work run in two

**Reported by the user:**

> command ran are not grouped properly

**Impact:** Grouping that works elsewhere breaks apart for no visible reason, so the transcript reads as inconsistent rather than organized.

Owner: `groupParts`, `message-timeline.data.ts:537`.

`skill` is in no group set, so it falls to the final branch (:622-625), which
flushes the in-progress context/work/task runs before emitting itself. Measured:

```
bash,bash,skill,bash,bash -> [ "work", "part", "work" ]
```

Interleaved assistant text does the same. On a harness that emits short prose
between tool calls this is a large share of the "commands are not grouped"
symptom, independent of D2.

## D4 — The auto-fold swallows subagent cards

**Reported by the user:**

> suagents are also folded.

**Impact:** Subagent cards are among the most valuable rows in a turn and they are hidden by default. The user has to hunt for the work they most want to see.

Owner: `isGroupFoldable` / `canFoldSettled`, `message-timeline.data.ts:171-200`.

The comment at :196-199 states the intent:

> A single tool is already one compact, useful row. Folding it replaces the only
> actionable content with an extra click and breaks the established
> standalone-tool/task-card contract.

But the guard is only `foldableCount >= 2`, and `isGroupFoldable` returns true for
the `agents` group type and for any standalone tool part — including a `task`. The
task-card contract that comment protects therefore holds only for a turn whose
*entire* tool activity is subagents. Measured:

```
2 tasks + 1 bash -> [ UserMessage, TurnFold(folded=true, count=2) ]
1 task  + 2 bash -> [ UserMessage, TurnFold(folded=true, count=2) ]
1 task  + 1 bash -> [ UserMessage, TurnFold(folded=true, count=2) ]
3 tasks only     -> [ UserMessage, AssistantPart(agents) ]      survives
1 task only      -> [ UserMessage, AssistantPart(part) ]        survives
```

The rule is inverted from the intent: the more real work a turn does alongside a
subagent, the more certain the subagent card is to disappear behind
"Worked for Xs". D2 makes this near-universal on the Claude harness, because every
capitalized tool becomes its own foldable `part` and `foldableCount` passes 2
immediately.

## D5 — `timelineFoldWhileRunning` is on by default with no way to turn it off

**Reported by the user:**

> i hve to clickon working toggle to see list of commands. why so? is this expected?

**Impact:** Behavior the user dislikes, on by default, with no setting anywhere to turn it off.

Owner: `packages/claxedo-app/src/platform/settings/provider.tsx:120`.

Defaults to `true`; consumed at `message-timeline.tsx:570` → `canFoldRunning`
(`message-timeline.data.ts:203`). There is no settings-UI control and no i18n label
for it anywhere in the repo, so it can only be changed by hand-editing the store.

The fold itself is intentional and keeps the last live group visible. Listed here
because D2 and D4 push far more behind it than the design assumed, and because a
user who dislikes it has no supported way to opt out.

## D6 — `core-harness-rendering-matrix.spec.ts:753` does not test what it claims

**Reported:** Not user-reported. Found while investigating D2 — recorded because it explains why D2 was never caught.

Named *"raw \"Grep\" falls back to GenericTool"*, it asserts a
`basic-tool-tool-title` with text `"Grep"`. But `ui.tool.grep` is literally
`"Grep"` (`packages/ui/src/i18n/en.ts:136`) and `getTool` lowercases, so the real
`grep` renderer produces the same title. The assertion passes under either
renderer and cannot distinguish them. Presumably how D2 stayed invisible.

## D7 — Subagents bypass the workspace panel entirely and invent a one-off right-side split

**Reported by the user:**

> subagent card does'nt open in right workspace panel

> this is big bug : i don't know how but one subagent session opened, and instead
> of using workspace panel and rendering there as tab, it creating this new
> pattern of rendering right side screen which is wrong, it must open in
> workspacepane as subagent tab and n can render in n tabs

**Impact:** A second layout pattern exists in the product for exactly one feature.
The user's mental model — everything opens in the workspace panel as a tab — is
broken by subagents alone, and N subagents cannot be held as N tabs.

Correction: an earlier revision of this entry framed the defect as "the right
split does not reliably fire" and went looking for which of four conditions
fails. That was the wrong frame. The four conditions are real, but they gate the
wrong mechanism — the panel is not involved at any point.

Owner: `openSubagent`, `packages/claxedo-app/src/features/session/ui/message-timeline.tsx:240-268`.

```ts
if (window.matchMedia(`(min-width: ${BP_MD}px)`).matches && paneId && !childPane && !dedicatedPane) {
  claxedoState.layout.splitContent(paneId, "right", contentId)
} else if (dedicatedPane && !childPane) {
  claxedoState.wb.panes.assign(dedicatedPane, contentId)
  claxedoState.layout.showContent(contentId)
} else {
  claxedoState.layout.showContent(contentId)
}
```

The "right" here is a **split edge**, not the workspace panel. This calls
`layout.splitContent`, which physically divides the content area — a different
subsystem from `workspacePanel.open(...)` that every other surface uses.

Two facts make this conclusive:

**`splitContent` has exactly one caller in the entire app.** Its only use outside
its own definition (`app/workbench/state/orchestration.ts:58` and `:606`) is
`message-timeline.tsx:261`. Subagents are the sole consumer of a whole layout
mechanism. Everything else — review, files, browser, processes — goes through
`claxedoState.workspacePanel.open(…)`.

**There is no subagent tab kind.** `WorkspacePanelFocus`
(`workspace-panel-body.tsx:53-64`) enumerates `review`, `file`, `browser`,
`process`, and `context`. A subagent has no representation in the panel, which is
why it could not have opened there even if routed correctly.

### Change points

The user's proposed model — open in the workspace panel as a subagent tab, N
subagents as N tabs — is well supported by what already exists:

- The panel is already multi-tab and keyed per target: `panelFocusTarget`
  returns a distinct target per file path, process id, or session id, and
  `workspacePanelTopLevelOpenTarget` speaks of preserving "every warm inner tab
  in the working set". N tabs needs no new mechanism.
- `context` already carries a `sessionId` (`workspace-panel-body.tsx:61-62`) and
  is the closest existing kind. Either extend it or add a `subagent` kind beside
  it.
- Route `openSubagent` through `workspacePanel.open` and delete the
  `splitContent` branch. That removes `splitContent`'s only caller, so the
  orchestration API can likely go with it — one layout pattern instead of two.

Read.

## D8 — Subagent card overflows the transcript column

**Reported by the user:**

> suabent card is going outside normal width.

**Impact:** The card breaks the transcript column and makes the layout look broken.

Reported. Not yet investigated; the two background agents assigned to D7/D8 were
killed before reporting.

## D9 — Videos cannot be attached to the composer (by design, not by filter)

**Reported by the user:**

> can't paste videos in composer.

**Impact:** Pasting a video silently fails with a generic “unsupported” toast that does not say videos are not supported at all.

Owner: `attachmentMime`, `packages/claxedo-app/src/features/session/composer/ui/files.ts:52`.

The paste handler itself (`attachments.ts:93`) does **not** filter by MIME — it
accepts any `item.kind === "file"`. The rejection is downstream:

```ts
export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type
  …
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (!textBytes(bytes)) return undefined     // video lands here
  return "text/plain"
}
```

`IMAGE_MIMES` is `ACCEPTED_IMAGE_TYPES` = `["image/png","image/jpeg","image/gif","image/webp"]`
(`packages/claxedo-app/src/lib/file-picker.ts:1`). A `video/mp4` is not an image,
not a PDF, not text-ish, and sniffs as binary → `undefined` → `add()` shows the
generic "paste unsupported" toast and drops it.

This is deeper than a filter. The attachment the composer builds is hardcoded
`type: "image"` as an `ImageAttachmentPart` (`attachments.ts:60-66`), so the
prompt model has no non-image attachment kind at all. Supporting video is a
feature with a contract change, not a one-line allowlist edit. Same gate applies
to drop and the file picker, so no path accepts video today.

Read.

## D10 — Sending while a turn is running aborts it instead of steering or queueing

**Reported by the user:**

> I hit send another msg in composer, instead of getting queud or steer, it hosws me you stoped after x minute. first it stops current turn then send another msg

**Impact:** The user expected to steer or queue. Instead their work was cancelled and their message was not sent — two unwanted outcomes from one keystroke, neither of them asked for.

Owner: `admitPromptSubmission`,
`packages/claxedo-app/src/features/session/commands/prompt-admission.ts`.

```ts
/** The primary composer control stops an active turn, even with a queued draft. */
export function admitPromptSubmission(input): PromptAdmission {
  if (input.working) return "abort-active"
  if (input.bodyMd.trim().length > 0 || input.imageCount || input.commentCount) return "admit"
  return "ignore"
}
```

`working` is tested **before** the text is considered, and the caller
(`composer/ui/submit.ts:173`) does `if (admission === "abort-active") return abort()`.
So Enter-with-text mid-turn stops the turn and never submits; the draft stays in
the composer and a second Enter sends it. That is exactly the reported "first it
stops current turn then sends another msg", and the "you stopped after X minutes"
notice is the abort surfacing.

The runtime already supports the intended behavior. `packages/workspace-runtime/src/opencode/session-port.ts:74-78`:

```ts
/**
 * How V2 admits the turn. `steer` interrupts the running turn with this
 * text; `queue` waits for it to finish. Claxedo's "send while running"
 * maps to `steer`.
 */
delivery?: "steer" | "queue"
```

`opencode/harness-adapter.ts:224` sets `delivery: "steer"`. But **no app code ever
passes a prompt `delivery`** — every `delivery` hit under `claxedo-app` is the
unrelated permission-mode delivery. A one-sided seam: the port documents the
contract and the client never fulfills it, so the composer falls back to a policy
that conflates Send with Stop.

Read.

## D11 — Selecting a session bumps it to the top of the list

**Reported by the user:**

> most recent session auto moves to top, which make means, as soon as i click second session it moves to first , feels like auto jumped back this is very bad

**Impact:** The list reorders under the pointer mid-click. The user's word: **very bad**. It makes the sidebar feel unreliable to aim at.

Owner: `bumpSessionListActivity`,
`packages/claxedo-app/src/features/session/data/sync/directory-event-projector.ts:120`.

```ts
case "message.completed":
case "session.idle": {
  bumpSessionListActivity(input)
  break
}
```

`bumpSessionListActivity` writes `updatedAt: Date.now()` — the client wall clock at
event receipt, **not** the session's real last-activity time. Contrast the
`session.updated` branch immediately above (:145), which correctly uses
`info.updated` from the event.

Every session list sorts strictly by that value, descending, with no stable
secondary key and no pinning of the selected row:

- `data/sync/queries.ts:142` — `sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))`
- `data/query/session-list.ts:538` — `sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))`
- `data/sync/inventory-source.ts:400` — `sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))`

So a `session.idle` event arriving on open rewrites the clicked session's position
to "now" and the list reorders under the pointer — the row jumps from second place
to first as it is clicked. This directly violates the standing requirement above.

Two separable defects: (a) `session.idle` should not be treated as activity, or
should carry the session's real timestamp rather than `Date.now()`; (b) the list
should not reorder while the user is interacting with it, regardless of what the
data does.

Read.

## D12 — Completed blocks keep growing after paint (progressive list staging)

**Reported by the user:**

> there are times one transcript above last para is updating, which si also bad

**Impact:** Text the user is reading moves under them because a block above is still growing. Called out as **bad** in its own right.

Owner: `stageMarkdownCollections`,
`packages/session-ui/src/components/markdown-progressive.ts`.

Any rendered block containing a `ul`, `ol`, or `tbody` with **more than 20**
children is painted with only its first **8** rows. The rest are removed from the
DOM, then re-appended **4 per animation frame** after a **260 ms** delay:

```ts
const initialRows = 8
const batchRows = 4
const minimumRows = 20
…
collections.forEach((entry) => entry.children.slice(initialRows).forEach((node) => node.remove()))
…
delays.set(root, setTimeout(() => { … requestAnimationFrame(step) }, 260))
```

A 40-row list therefore grows for 8 frames after a 260 ms pause; a 100-row list
for 23 frames. The block's height increases monotonically *after* it has been
painted, so everything below it — including the streaming tail the user is
reading — is pushed down for the whole window.

This matches the report directly: a block that has finished streaming stabilizes
its hash, but its final `stageMarkdownCollections` pass is still re-growing it
while the *next* block streams below. The paragraph above the last one is visibly
still updating.

`markdown.tsx:1038-1042` does guard re-entry with a `data-markdown-hash` check, so
an unchanged block is not re-staged. Two windows remain:

- First paint of every qualifying block (the main one).
- The block currently streaming, whose hash changes on each delta — it is
  re-truncated to 8 rows and re-grown on every token.

Not yet checked: whether the timeline virtualizer re-measures during the regrow,
or whether rows below sit at stale offsets until the next measurement pass. That
determines whether the symptom is smooth push-down or a jump. Worth resolving
before choosing a fix, since it decides whether the fix is "reserve the final
height up front" or "drop the staging entirely".

Read.

## D13 — `markdown-rich-stage.ts` is dead production code with a test that cannot fail

**Reported:** Not user-reported. Found while investigating D12 — recorded as debt and as a second instance of the D6 pattern.

Owner: `packages/session-ui/src/components/markdown-rich-stage.ts`.

`shouldStageCompletedMarkdown` takes four inputs and ignores all of them:

```ts
export function shouldStageCompletedMarkdown(input: {
  streaming?: boolean; delayMs: number; cacheKey?: string; text: string
}) {
  if (input.streaming) return false
  if (input.delayMs <= 0) return false
  if (!input.text) return false
  return false          // every path returns false
}
```

Outside its own test file, neither it nor `scheduleCompletedMarkdownRichUpgrade`
nor `completedMarkdownRichDelayMs` is referenced anywhere in the repo. The
plain-then-rich staging this module implemented was disabled by making the
predicate constant rather than by deleting the module, and the module survives
only because its test imports it.

`markdown-rich-stage.test.ts:46-47` asserts `false` for inputs whose result is
unconditionally `false` — it would pass against an empty function body. Same class
as D6: a test that cannot distinguish the behavior it names.

This is not the cause of D12 — the plain→rich morph is genuinely off. Recorded as
debt to delete, and as a second instance of the assertion-that-cannot-fail pattern.

Read.

## D14 — Assistant text can be emitted twice (snapshot/delta reconciliation fallback)

**Reported by the user:**

> see duplciate msgs
>
> same thing in unfolded

**Impact:** The transcript shows content that was never produced twice. The user checked the unfolded view to rule out a display artifact, which is exactly the right instinct — it is a data defect.

Owner: `packages/agent-event-runtime/src/harnesses/claude/adapter.ts:862-870`.

Assistant text reaches the projection twice over: as streamed `text_delta`s, and
again as a cumulative snapshot on the completed assistant message. The adapter
reconciles them by subtracting what it has already emitted:

```ts
const snapshot = assistantSnapshotText(rawMessage)
const childOwned = !!claudeChildCorrelationKey(rawMessage)
const deltaText = childOwned
  ? snapshot                                             // 1
  : snapshot.startsWith(state.emittedAssistantText)
    ? snapshot.slice(state.emittedAssistantText.length)   // 2  correct: emit the tail
    : state.emittedAssistantText.endsWith(snapshot)
      ? ""                                               // 3  already emitted
      : snapshot                                         // 4  emit EVERYTHING again
```

Branch 4 is a duplication fallback: when the snapshot is neither a continuation of
the emitted text nor already contained in it, the adapter re-emits the **entire
snapshot** on top of the deltas already streamed. The message then renders twice.

Reaching branch 4 requires only that the deltas and the snapshot diverge before
their common tail.

Correction: an earlier revision of this entry blamed the dropped `citations_delta`
/ `signature_delta` / `compaction_delta` cases at `:763-768`. Reading the
accumulation paths refutes that — those deltas do not contribute text to a text
block, so they cannot desynchronize `emittedAssistantText` from the snapshot. The
claim was written before the paths were read and is withdrawn.

What the accumulation paths actually show, confirmed by reading:

- `text_delta` (:722) appends to `emittedAssistantText`.
- `content_block_stop` with a text block's `fallbackText` (:782) also appends.
- `thinking_delta` (:730) correctly does **not** append; thinking is not in the
  text snapshot.
- `emittedAssistantText` is replaced with this message's snapshot on completion
  (:899) and reset to `""` only on `result` (:918) — once per turn, not per
  message.

So within one turn carrying several assistant messages, at message N's completion
`emittedAssistantText` holds `snapshot(N-1) + deltas(N)`, and `snapshot` holds
only message N's text. Branch 3's `endsWith` check absorbs that correctly **when
the streamed deltas exactly equal the final snapshot text**. When they do not —
any message whose deltas cover only part of its final text — `endsWith` fails and
branch 4 re-emits the whole snapshot on top of what already streamed.

Branch 1 is a second, simpler exposure: for child (subagent) messages the full
snapshot is always emitted, and the state update deliberately skips recording it —
`...(snapshot && !childOwned ? { emittedAssistantText: snapshot } : {})`. Two
snapshots for the same child message emit their full text twice with no
suppression possible.

The user confirms the duplicate is assistant text repeated within one reply, and
that it persists in the unfolded view — so this is a data-layer duplication, not a
fold or virtualizer rendering artifact. Which of branch 1 or branch 4 fires needs
the raw harness event stream for a reproducing turn; that has not been captured.

The e2e coverage cannot catch this. `core-harness-rendering-matrix.spec.ts:645-649`
asserts `"Building the Building the"` has count 0, but its own comment concedes:

> The adapter turned the provider's cumulative snapshots into deltas before the
> trace was recorded, so this checks accumulation, not snapshot dedup.

The fixture is pre-normalized, so the recorded trace never exercises the
reconciliation at all. Third instance of the can't-fail-assertion pattern after
D6 and D13.

Read. Not yet confirmed as the cause of the user's report — see the open question
below.

## D15 — A resolved question flashes when navigating back to a session

**Reported by the user:**

> an already reoslved question appaering for a brief second when i navigate back from other sesson

**Impact:** A question the user already answered reappears as if it still needs them. Even for a second, it re-raises work that is done.

Owner: `applyDirectorySessionMeta`,
`packages/claxedo-app/src/features/session/store/directory-session-meta.ts:21`.

The pending permissions/questions the docks read are a pure client cache. The
query is declared with `queryFn: skipToken, enabled: false`
(`store/session-pane-queries.ts:58`), so it never refetches — it holds whatever
was last dispatched into it, keyed by session id, and keeps holding it after you
navigate away.

Answering a question clears that entry by dispatching a fresh `session.requests`
(`ui/composer/session-question-dock.tsx:213`). Returning to the session re-runs
the directory status/permission/question hydration, which calls
`applyDirectorySessionMeta` and dispatches `session.requests` again from that
read. If that read was taken or cached before the answer landed, it re-seeds the
already-answered question into the cache; the next authoritative event clears it
again. The dock renders in between — the brief flash.

Two writers with no ordering guarantee feed one cache entry. The module's own
header comment already names this hazard for status:

> This payload has two independent authorities that fetch it — the session pane's
> hydration (`syncSessionMeta`) and the rail's status batch … Both must produce
> the same status from the same bytes, or the two writers flap against each other
> through the shared cache entry.

The same reasoning applies to requests, but there is no staleness guard on that
leg — no timestamp or generation counter — so an older read can overwrite a newer
resolution. Basic exploration only; the exact re-seeding caller on the
navigate-back path was not traced.

Related: memory records a plan
(`2026-09-07-001-feat-transcript-interaction-records-plan.md`) to make questions,
permissions, and todos persisted transcript parts instead of transient tables,
which would remove this class outright.

## D16 — Composer images persist into other threads and new threads

**Reported by the user:**

> i had sent images in other thread, but when i come back to other thread or new thread i find those images in composer

**Impact:** Attachments from one conversation follow the user into another. Beyond confusing, this risks sending an image into the wrong thread.

Owner: prompt draft scoping, `composer/ui/submit-prompt-scope.ts:21`.

Images are not a separate store — `imageAttachments` is a memo over the draft
(`composer/composer.tsx:304`):

```ts
const imageAttachments = createMemo(() =>
  prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
)
```

So an attached image is a `type: "image"` part inside the prompt draft, and
clearing the draft should clear it. `createSubmitDraftLifecycle.clear()`
(`submit-draft-lifecycle.ts:28`) resets each submitted scope.

The scope is the suspect:

```ts
export function promptViewScope(input: { directory?: string; sessionId?: string; draftId?: string }) {
  return { dir: input.directory ?? "", id: input.sessionId, ...(input.draftId ? { draftId: input.draftId } : {}) }
}
```

For a **new thread** there is no session id and no draft id, so the scope collapses
to `{ dir, id: undefined }` — a single draft shared by every new thread in that
directory. An image attached in one new thread is therefore the same draft every
later new thread in that directory mounts. That accounts for the "new thread"
half of the report directly.

The "come back to another existing thread" half is not explained by that alone,
since a real session id gives a distinct scope. Not traced further — basic
exploration only. The thing to check next is whether `add()`
(`composer/ui/attachments.ts:60-68`) writes through `prompt.set(...)` with no
scope argument, and therefore lands on whichever scope is mounted at paste time
rather than the one the user believes they are typing into.

Update: a second writer with exactly that shape was found while investigating
D29. `app/workbench/workspace-panel/browser-panel.tsx:68` appends a browser
screenshot to the draft with no scope:

```ts
prompt.set([...prompt.current(), attachment])
```

`composer/ui/attachments.ts:67` does the same for pasted files. So at least two
attachment writers target the ambient mounted scope rather than an explicit one,
which is consistent with an image following the user into a thread they did not
attach it to.

## D17 — A late-landing abort stops the wrong turn

**Reported by the user:**

> the msg i send when i turn is going(cancel current turn - that is already recorded) but it also stops current turn like after 5 seconds

**Impact:** A second stop the user never asked for, arriving late and killing a turn they had just started. Work is lost with no visible cause.

Owner: `createPromptAbort`, `composer/ui/submit-abort.ts`, and the abort contract
it calls.

The abort carries no turn or message identifier:

```ts
abort(input: { sessionID: string; directory: string }): Promise<…>
```

`createPromptAbort` awaits that network call. Nothing scopes it to the turn the
user was looking at when they pressed send, so whatever turn is running in that
session when the request arrives is the turn that dies.

Combined with D10, the reported sequence follows: the first Enter aborts turn 1
over the network; the user sends again and turn 2 starts; the in-flight abort
lands afterwards and stops turn 2. The user observes a second stop several
seconds after the first, on a turn they never asked to cancel.

The user reports roughly five seconds. That does **not** match the optimistic
status ladder — those stages are 8s / 20s / 45s / 5min
(`store/session-status-dispatcher.ts:13-16`) — so the delay is the abort round
trip, not a client timer. Timing not measured.

Note also that `registerPendingPrompt` (`submit/pending.ts:17`) is keyed by
session id alone and overwrites any existing entry without aborting it, so a
superseded controller is dropped rather than cancelled.

Basic exploration only; not reproduced.

## D18 — An interrupted turn loses its fold control entirely

**Reported by the user:**

> i expanded "working" folded tab -> started new turn, now no option to fold that back.

**Impact:** A control the user was actively using disappears. Having expanded a turn, they are stuck with it expanded forever.

Owner: `canFoldSettled`, `message-timeline.data.ts:200`.

`canFoldSettled = settled && !interrupted && !error && foldableCount >= 2`. When a
turn is interrupted, no `TurnFold` row is emitted at all, so there is no control
to fold it back — regardless of what the user had chosen. Measured:

```
settled, user expanded -> [ UserMessage, TurnFold(folded=false), Part(work), Part(context) ]
ABORTED, user expanded -> [ UserMessage, Part(work), Part(context), TurnDivider ]
```

This is the reported "I expanded Working, started a new turn, now no option to
fold that back". D10 is what makes it reachable every time: sending mid-turn
aborts the previous turn, which marks it interrupted, which deletes its fold row.

The user's explicit choice also persists in `turnFoldCache`
(`turn-fold-store.ts`), so the turn stays expanded even if it later stops
counting as interrupted.

Measured. (Reported in conversation earlier but omitted from this log; recorded
here after the user re-raised it.)

## D19 — Session switching shifts content

**Reported by the user:**

> there many content shift, title feels from going showing loader to no loader to loader
>
> folding happens after session switch

**Impact:** Directly against the user's own standing requirement: **no matter what happens there should be no content shift when i jump from one session to other.** Every switch visibly reflows.

Directly violates the standing requirement at the top of this document. Two
distinct symptoms reported:

**Title flickers loader → no loader → loader.** The title resolves through more
than one source and each transition repaints. Not traced.

**The fold is applied after the switch, not before the first paint.** Owner:
`message-timeline.data.ts:204` — `foldActive = canFoldSettled || canFoldRunning ? (userChoice ?? true) : false`.
Whether a turn folds depends on `settled`, `interrupted`, `error`, and
`foldableCount`, all derived from message data that arrives after mount. The
first frame therefore renders with the pre-hydration answer and re-folds once the
data lands, collapsing rows underneath the user.

`message-timeline.tsx:680` shows the cold/warm split feeding the same problem:

```ts
const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length ? 6 : 1)
```

A session without cached measurements mounts in a deliberately degraded state and
upgrades afterwards. Combined with D12 (blocks growing after paint) and D20
(under-rendered scroll band), a switch has at least three independent sources of
post-paint reflow.

Basic exploration only.

## D20 — Fast scrolling shows blank regions that fill in as they are reached

**Reported by the user:**

> on scroll losing frames -> i see big blank screen and rows render as i see in blank area

**Impact:** Scrolling shows empty space where content should be, and rows only appear once the user has already arrived. The transcript feels like it cannot keep up.

Owner: the `rangeExtractor` override in `message-timeline.tsx:758-768`.

`message-timeline.tsx:748` sets `overscan: 50`, but the custom `rangeExtractor`
immediately below replaces it with `renderOverscan()`, which is **1** on a cold
mount and **6** once measurements exist (`:680`, `:688`). The effective band is
1–6 rows, not 50, so the `overscan: 50` option is dead and misleading.

With rows as tall and variable as transcript turns, a fast flick outruns a
six-row band: the viewport reaches rows that have not been rendered yet, which is
the reported blank area that fills in as you arrive.

`timeline-virtualization.ts:118-129` documents this exact failure mode as already
addressed — `content-visibility: auto` was removed because "a fast flick scrolls
skipped rows into the viewport before the browser renders them, showing
estimate-sized blank boxes". The symptom is being observed again, so either that
mitigation regressed or the band is simply too small for the scroll speeds in
use.

That same comment asserts "The overscan band is small (≤6 rows)" — consistent
with `renderOverscan()` but contradicting the `overscan: 50` literal a few lines
away. One of the two is wrong on its face and should be resolved before tuning.

Basic exploration only.

## D21 — Expanded tool output has a hidden scrollbar and a silent 240px clip

**Reported by the user:**

> no scrollbar in expanded tool call

**Impact:** Output is cut off with nothing indicating more exists or that the region scrolls. The user cannot tell whether they have seen everything.

Owner: `packages/session-ui/src/components/message-part.css:387-397`.

```css
&[data-scrollable] {
  height: auto;
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar { display: none; }
}
```

The region scrolls but every scrollbar affordance is explicitly suppressed on all
three engines. Combined with `max-height: 240px`, an expanded tool call silently
clips its output with nothing indicating more content exists or that the area is
scrollable. `.error-card` (`session-turn.css:73`) uses the same 240px cap.

Correction after further reading: this is **not** uniform, and the inconsistency
is the real finding. The `bash` output region solves it properly
(`message-part.css:469-502`):

```css
.ui-bash-scroll {
  overflow-y: auto;
  max-height: 240px;

  /* Discoverable scrollability (T20): thin transparent-track scrollbar that surfaces
     on hover instead of the fully hidden bar. */
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
&:hover .ui-bash-scroll { scrollbar-color: var(--border-weak-base) transparent; }
```

So a fix for exactly this complaint was already made and shipped — for shell
output only. The shared `[data-component="tool-output"]` region every *other*
expandable tool uses (`grep`, `websearch`, `list`, `glob`, `GenericTool`) still
carries the fully-hidden variant. The T20 fix was never propagated to the
canonical owner, so the two surfaces disagree.

That also narrows the fix: adopt the `ui-bash-scroll` treatment on
`[data-component="tool-output"][data-scrollable]` rather than inventing one.

A second clip is worth checking separately: `[data-component="tool-output"]` sets
`white-space: pre` (`:360`) with no `overflow-x` of its own, and `.ui-bash-scroll`
sets `overflow-x: hidden` outright (`:472`). Long unwrapped lines may therefore be
horizontally unreachable in shell output. Not verified in a browser.

Read.

## D22 — The aborted/failed card is visually too heavy

**Reported by the user:**

> the Aborted by user based failed card is too bold and looks ugly

**Impact:** The user's words: **too bold and looks ugly.** The loudest treatment in the transcript is spent on an ordinary outcome. D28 explains why they see it so often.

Reported as "too bold and looks ugly".

Candidate owners, not yet narrowed:

- `packages/session-ui/src/components/tool-error-card.css:1` —
  `.ui-card[data-kind="tool-error-card"]`. On its own this is restrained
  (transparent background, `--border-weak-base`), so it is probably not the
  offender by itself.
- `session-turn.css:73` and `:230` — `.error-card` inside the turn, which sets
  `--v2-text-text-base` and the 240px cap from D21.
- `session-turn.tsx:292-299` decides interrupted-vs-error:
  `MessageAbortedError` marks the turn interrupted, and any *other* error becomes
  the error card. So a user abort and a genuine failure may be reaching different
  surfaces than intended — worth confirming which one the user is actually seeing
  before restyling either.
- `message-timeline.data.ts` emits a separate `TurnDivider({ label: "interrupted" })`
  for the abort case.

Needs a screenshot or the exact card text to identify which of these renders.
Basic exploration only.

## D23 — A shell row can render as the bare verb "Running" / "Ran" with no command

**Reported by the user:**

> tool call in folded on show "Running", "Ran" and nothing else sometimes.

**Impact:** A row that reports something happened but refuses to say what. The single most useful piece of information is the one that is missing.

Owner: the `bash` renderer, `packages/session-ui/src/components/message-part.tsx:2596-2612`.

```tsx
<span data-slot="basic-tool-tool-title">
  <TextShimmer text={pending() ? "Running" : "Ran"} active={pending()} />
</span>
{/* Keep the command in the header even while expanded — the verb alone
    ("Ran") says nothing, and the header is what you scan when scrolling. */}
<Show when={!pending() && displayCommand()}>
  <ShellSubmessage text={displayCommand()} animate={sawPending && !open()} />
</Show>
```

The command is the only informative part of the row and it is behind a two-part
guard. Two ways to reach a bare verb:

**`pending()` is true.** The guard is `!pending() && …`, so *every* running shell
row shows the bare word "Running" with no command — by construction, not by
accident. The command only appears once the call completes.

**`displayCommand()` is empty.** It reads
`stripShellWrapper(String(props.input.command ?? props.metadata.command ?? ""))`,
which yields `""` when neither key is present. An empty string is falsy, so the
`Show` renders nothing and the row is the single word "Ran". This is reachable
whenever the tool input never finished streaming — the input arrives by
`input_json_delta` accumulation (`claude/adapter.ts:744`) and is only committed
once the partial JSON parses, so a call interrupted mid-input completes with no
`command` key at all. D10 and D17 both produce exactly that: turns aborted while
a tool call was still streaming its input.

The comment above the guard already states the conclusion — "the verb alone
('Ran') says nothing" — while the guard it annotates permits precisely that
state.

Read.

## D24 — An expanded tool card survives its turn being folded

**Reported by the user:**

> the tool call card i have expanded and remain expaned even on turn folded

**Impact:** The user's explicit expand survives a fold that should have collapsed it, so the turn claims to be folded while plainly not being folded.

Owner: `shouldFold`, `message-timeline.data.ts:217-222`.

```ts
const shouldFold = (item, itemIndex) => {
  if (!foldActive || item.type !== "part" || !isGroupFoldable(item.group)) return false
  // Running-only phase fold keeps the last (live) group visible.
  if (canFoldRunning && !canFoldSettled && itemIndex === lastFoldableIndex) return false
  return true
}
```

While a turn is running, the last foldable group is deliberately exempted from
the fold so active work stays visible. The `TurnFold` row still renders with
`folded=true`, so the turn *reads* as folded while that one group — including a
tool card the user expanded — remains on screen underneath it. The state looks
inconsistent even though each half is behaving as written.

Per-tool open state is separately persistent (`toolOpen`,
`message-timeline.tsx:677`, cached per session in `timelineCache` at `:933`), so
an expanded card stays expanded across the fold and across pane remounts rather
than collapsing with its turn.

Whether the reported case is this exemption or a genuine leak needs the turn's
running/settled state at the time; if the turn had already settled,
`canFoldRunning` is false and the exemption cannot apply, which would point
somewhere else. Basic exploration only.

## D25 — "Thinking…" appears, drops, and returns on send

**Reported by the user:**

> there is content shift when i send msg.
>
> because "thinking..." text appears for a second and then disappers immediately and then comes back

**Impact:** Sending a message — the single most common action in the app — makes the view jump. Again against the no-content-shift requirement.

Owner: `nextThinkingVisibilityHold`,
`packages/claxedo-app/src/features/session/ui/thinking-visibility-hold.ts`.

The flap is already known and already mitigated — the module header says so:

> Status can blip idle→busy (or settled→unsettled) for a few frames while a
> stream is still running. Dropping the row immediately collapses the
> virtualizer and jumps the composer.

The mitigation is a hide-only hysteresis of **80 ms**:

```ts
export const THINKING_HIDE_HOLD_MS = 80
```

80 ms is about five frames. It covers a few-frame blip and nothing longer. On
send, the sequence is optimistic-busy → server-reported-not-yet-busy →
actually-busy, and the middle leg is a network round trip, which is one to two
orders of magnitude longer than the hold. The row therefore drops and returns —
the reported behavior — because the hold was sized for a render blip, not for a
request.

Two further observations:

- The hold is one-sided. It delays hiding but not showing, so an optimistic show
  followed by a real hide still produces a visible appear/disappear pair.
- A second, unrelated hold exists for the same family of transitions:
  `createTimelineWorkingStatus` (`timeline-working-status.ts`) defaults to
  `hideDelay = 260`. Two different constants (80 and 260) govern the visibility
  of two rows that flip on the same status changes, so they cannot stay in sync
  by construction.

Read.

## D26 — `TextShimmer` repaints text every frame, per instance, forever

**Reported by the user:**

> shimmering in tool call/thinking text or loader in header have performance issues, find performant alternative

**Impact:** The user identified this as a performance problem unprompted and asked for a cheaper approach, not a defence of the current one.

Owner: `packages/ui/src/components/text-shimmer.css` and
`packages/ui/src/components/text-shimmer.tsx`.

The effect animates `background-position` on an element using
`background-clip: text`:

```css
[data-component="text-shimmer"] .ui-text-shimmer-char-shimmer[data-run="true"] {
  animation-name: text-shimmer-sweep;
  animation-duration: var(--text-shimmer-duration);   /* 1200ms */
  animation-iteration-count: infinite;
  will-change: background-position;
}

@keyframes text-shimmer-sweep {
  0%   { background-position: 100% 0, 0 0; }
  100% { background-position:   0% 0, 0 0; }
}
```

Why this is the expensive shape:

- `background-position` is not a compositor-animatable property. Combined with
  `background-clip: text` the browser must re-rasterize the glyph mask against
  the gradient **on every frame**. `will-change` promotes a layer but cannot
  remove the repaint; it only hints.
- `--text-shimmer-size: 360%` makes the gradient 3.6× the element width, so each
  of those repaints covers a large raster area.
- `animation-iteration-count: infinite` — it never stops while the row is
  mounted.
- The cost is per instance and they run concurrently. `TextShimmer` is used by
  the thinking row, every `BasicTool` title (`message-part.tsx:1232`), the bash
  verb (`:2604`), the skill title (`:3157`), and the reasoning title (`:2142`).
  Every running tool row is an independent infinite text repaint.
- The component renders the text **twice** in the DOM (`text-shimmer-char-base`
  plus `text-shimmer-char-shimmer`) for every instance, active or not, doubling
  glyph count across a long transcript.
- `data-run` only clears 220 ms after `active` goes false, so the animation keeps
  running past the point it is visible.

Performant alternatives, cheapest first:

1. **Opacity pulse** — compositor-only, no repaint. Loses the sweep look.
2. **Transform-animated overlay** — keep the gradient in a pseudo-element and
   animate `transform: translateX()` instead of `background-position`, with the
   text as a `mask-image`. Transform and opacity are the only two properties the
   compositor animates without paint.
3. **Shimmer one row at a time** — restrict the effect to the single active row
   rather than every pending tool title. Reduces N concurrent animations to 1
   regardless of which technique is used.

The `prefers-reduced-motion` branch already disables the animation entirely, so a
non-animated fallback path exists and is known to render acceptably.

Read. Not profiled — the analysis is from the animated property and the usage
count, not from a measurement. A trace should confirm paint cost before choosing
between the alternatives.

---

# Design requests (not defects)

Recorded separately from D1–D26: these describe intended product behavior that
differs from what is built, not code failing its own contract.

## R1 — The question tool should be its own surface, and an answered question should persist as a card

Requested by the user on 2026-09-09:

> question tool should be a clearly separate tool in UI, and the answered thing
> should be clearly visible as a very nice looking card with the answered answer,
> and not just go away like any other tool call.

### What it does today

Owner: the `question` entry in `ToolRegistry`,
`packages/session-ui/src/components/message-part.tsx:3101-3147`.

An answered question renders through the *same* `BasicTool` chrome as `bash`,
`read`, and `grep` — leading icon, title, subtitle, collapsible body:

```tsx
<BasicTool
  {...props}
  defaultOpen={completed()}
  icon="bubble-5"
  trigger={{ title: i18n.t("ui.tool.questions"), subtitle: subtitle() }}
>
```

The content is there and it does default to open once answered, so the answer is
not lost. What is missing is any visual distinction: it is a tool row among tool
rows.

Its full lifecycle today is three different surfaces:

1. **Pending** — excluded from the transcript entirely.
   `message-timeline.data.ts` `renderablePart()`:
   `if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"`.
   It lives in `session-question-dock.tsx` instead.
2. **Answered** — becomes an ordinary `BasicTool` row in the transcript.
3. **Turn settles** — and it disappears.

### Why it "goes away"

Step 3 is the substantive half of the request, and it is mechanical.
`isGroupFoldable` (`message-timeline.data.ts:171`) returns true for any
`group.type === "part"` whose part is a tool. An answered question *is* a tool
part, so it is foldable, it counts toward `foldableCount`, and once the turn
settles with two or more foldable groups it is hidden behind "Worked for Xs"
along with the shell commands.

So the answer the user gave — the one piece of the turn they authored themselves
— is collapsed by the same rule that collapses `ls`. That is the behavior being
objected to, and it is D4's mechanism reaching a part that should have been
exempt.

### Change points

- **Exempt questions from the fold.** `isGroupFoldable` should return false for
  `question` parts, the same way the code already special-cases them in
  `renderablePart`. This is the smallest change and it alone fixes "goes away".
- **Give it its own renderer.** Today it reuses `BasicTool`. A dedicated card —
  like `SubagentTaskCard` (`:2537`) or `ToolErrorCard`, both of which already
  escape the standard row chrome — would make it visually distinct without
  inventing a new mechanism.
- **Decide the pending surface.** The dock/transcript split means a question is
  in one place while unanswered and another once answered. If the card is to be
  the durable record, it may want to own both states rather than hand off.
- Related: `2026-09-07-001-feat-transcript-interaction-records-plan.md` already
  proposes making questions, permissions, and todos persisted transcript parts
  instead of transient dock tables. That plan is the natural home for this.

## D27 — A running tool is uninspectable: no name, no chevron, and clicks are discarded

**Reported by the user:**

> see all the one "running" for minutes, i can't click and see what is, very bad

**Impact:** Minutes of watching a row that will not say what it is doing and will not respond to being asked. The user's word: **very bad**.

Owner: `BasicTool`, `packages/session-ui/src/components/basic-tool.tsx`.

Reported as: a row sits on "Running" for minutes and cannot be clicked to find
out what it is.

Three independent guards all key off `pending()`, and together they remove every
way to learn what a running tool is doing:

**1. Clicks are explicitly discarded** (`:211-215`):

```ts
const handleOpenChange = (value: boolean) => {
  if (pending()) return
  if (props.locked && !value) return
  setOpen(value)
}
```

The row is still a Kobalte `Collapsible.Trigger`, so it is focusable and
hover-styled — it looks interactive and silently does nothing. Same dead-click
shape as D1, but here it is a deliberate early return rather than an absent
handler.

**2. The chevron is suppressed** (`:292`):

```tsx
<Show when={hasChildren() && !props.hideDetails && !props.locked && !pending()}>
  <Collapsible.Arrow />
</Show>
```

So there is not even an affordance suggesting the row could expand.

**3. The command is hidden** — D23. The `bash` renderer gates its command behind
`!pending()`, so the title is the bare word "Running".

The only thing a running row does surface is elapsed time (`:289`), which is why
the symptom reads as "Running" plus a growing duration and nothing else. For a
long command that is minutes of a row that says something is happening, will not
say what, and refuses to be asked.

Note the guards are not redundant — fixing any one alone is insufficient.
Removing the `pending()` term from the chevron without also fixing
`handleOpenChange` produces a chevron that does nothing; fixing both without D23
produces an expandable row whose header still will not name the command.

Worth questioning whether `pending()` should gate interaction at all. Streaming
output is the single most useful thing to see while a command runs, and the
partial input is usually available before completion — the `bash` input carries
`command` as soon as its `input_json_delta` accumulation parses
(`claude/adapter.ts:744`), which is typically long before the command finishes.

Read.

## D28 — Any non-zero exit code is recorded as a tool error

**Reported by the user:**

> I don't know if exit tools are rcorded as error, also very bad

**Impact:** The user cannot trust the error state, because it fires on normal results. Called **very bad** — an error surface that cries wolf is worse than none.

Owners: the per-harness adapters in `packages/agent-event-runtime/src/harnesses/`.

Every harness treats a non-zero process exit as a failure and emits `tool-error`:

**Codex** (`codex/adapter.ts:534-549`):

```ts
const exitCode = asFiniteNumber(input.row.exitCode) ?? 0
…
exitCode === 0
  ? { /* normal completion */ }
  : { type: "tool-error", toolCallId: input.toolCallId,
      error: output || `Process exited with code ${exitCode}`, … }
```

The same mapping again at `codex/adapter.ts:749-750`.

**Cursor** (`cursor/adapter.ts:356-357`):

```ts
const exitCode = asFiniteNumber(nested?.exitCode)
return exitCode !== undefined && exitCode !== 0
```

**Claude** keys off the SDK's own flag rather than the code —
`isError: block.is_error === true` (`claude/adapter.ts:220`), consumed at `:826` —
but Claude Code sets `is_error` for a non-zero Bash exit, so the observable
behavior matches.

A non-zero exit is not a failure in general; it is how a large class of standard
tools reports a normal negative result:

| Command | Exit | Meaning |
|---|---|---|
| `grep pattern file` | 1 | no match — expected, often the point of the call |
| `diff a b` | 1 | files differ |
| `git diff --quiet` | 1 | there are changes — this is the documented use |
| `test` / `[ … ]` | 1 | condition false |
| a failing test suite | non-zero | a real result the agent asked for |

So a `grep` that finds nothing renders identically to a crash. The transcript
loses the distinction between "the tool failed" and "the tool answered no", which
is the distinction the reader actually needs.

This compounds D22: the error card is visually heavy, and this defect makes it
fire on routine negative results, so the loudest surface in the transcript is
attached to the most ordinary outcome.

Worth noting the harnesses disagree in shape even while agreeing in effect —
Codex reads `exitCode` directly, Cursor reads a nested `exitCode`, Claude reads
`is_error`. Any fix has to land in all three or the surfaces drift.

Read. Which harness the user is on was not confirmed.

---

## R2 — A tool row should be able to show its complete output

Requested by the user on 2026-09-09:

> not sure what tool it is, but i want to see complete msg in that tool

Good news first: **the output is not truncated in the data.** A search of the
runtime and projection paths found no general output cap on the way to the UI —
the only truncations are `session-handoff.ts:14` (handoff context, unrelated) and
`acp/title.ts:126` (title generation, unrelated). `clampLabel`
(`message-part.tsx:1321`, 72 chars) affects only the collapsed `WorkGroup`
*header* label, never a body.

So everything needed is already client-side. What withholds it is a stack of
independent presentation limits, each recorded separately:

| # | Limit | Effect |
|---|---|---|
| D27 | `pending()` blocks clicks, hides the chevron | cannot open a running tool at all |
| D23 | command hidden while pending | cannot tell which tool it is |
| D21 | `max-height: 240px` + hidden scrollbar on `tool-output` | output clipped with no cue |
| D12 | lists >20 rows render 8, grow after 260 ms | long list output arrives late |
| D21 | `white-space: pre` / `overflow-x: hidden` | long lines may be horizontally unreachable |

These are five separate guards, so "show me the whole thing" is not one change.
The user-visible requirement is a single sentence — a tool row must be able to
reveal its complete content, running or finished — and satisfying it means
resolving all five, or introducing one deliberate "full output" surface that
bypasses them (an expand-to-pane or copy-all affordance) rather than loosening
each limit in place.

The second option is likely cheaper and is more consistent with D21's finding
that the one surface which *did* get fixed (`ui-bash-scroll`, T20) diverged from
the shared one rather than fixing it.

## D29 — Opening one panel silently switches you to a different one

**Reported by the user:**

> i find when i open browsr -> files panel opened it self, then when i clicked
> full screen review panel open itself very irrtitating.

**Impact:** The user opens Browser and lands on Files; goes full screen and lands
on Review. Their explicit choice of surface is discarded twice in a row by the
app itself. Their word: **very irritating**.

Owner: `workspacePanelTopLevelOpenTarget`,
`packages/claxedo-app/src/app/workbench/rail/workspace-panel-visual-state.ts:27-54`.

Both overrides are in the code, each with a comment explaining the intent:

```ts
// A first top-level open has no prior surface to restore. Files is the
// useful workspace default and lets the shell begin loading the tree at
// the opening click; later closes/reopens preserve the user's selection.
navigator: panel.navigator ?? "files",

// The physical top-level button means "open Workspace", whose primary
// surface is Review. Preserve every warm inner tab in the working set, but
// explicitly reactivate Review instead of restoring an arbitrary process
// or file tab from the last close.
// A focus request still present here has not been consumed …
...(panel.focus ? {} : { focus: { kind: "review" as const } }),
```

Read on their own terms both are defensible: Files is a reasonable cold default,
and a button labelled "open Workspace" reasonably lands on Review.

The defect is the condition they are gated on. The Review override fires whenever
`panel.focus` is absent — and `panel.focus` only holds an *unconsumed focus
request*, not the surface the user is currently on. There is no term anywhere in
this function for "the user already chose Browser". So a top-level open reactivates
Review over a live Browser panel, and the `?? "files"` default applies on any path
reaching it without a navigator, not only the genuine first cold open its comment
describes.

Both comments say "preserve the user's selection" / "preserve every warm inner
tab", which is the intent this code does not implement for the active surface.

Read.

## D30 — A localhost URL cannot be opened from the transcript, and the browser tab does not survive navigation

**Reported by the user:**

> i can't click http://localhost:6006/?path=/story/playground-transcript-lab--lab and open in browser
>
> i manually opened the link went back and it vanished

**Impact:** A URL the agent produced cannot be acted on. The user worked around it
by opening the link by hand, and lost even that when they navigated away.

Two separate problems, neither fully traced.

**Not clickable.** A URL extractor exists (`message-part.tsx:613`) and handles
this shape correctly — `/https?:\/\/[^\s<>"'`)\]]+/g` matches the whole URL
including `?path=/story/…`, and the trailing-punctuation strip
(`[),.;:!?]+$`) does not touch it since it ends in a letter. So extraction is not
the failure. What was not established is whether transcript text routes a URL to
anything: `openBrowserTab(url)` exists
(`app/workbench/review/review-workspace.tsx:235`) and `platform.openLink(url)`
exists for external opens (`app/composition/agent-plugin-ports.tsx:83`), but
whether a URL rendered in assistant text or tool output is wired to either was
not confirmed.

Note the `bash` renderer has a narrower path that *does* work — a "Local preview"
chip from a localhost match in command output (`message-part.tsx:2578-2585`). If
the URL arrives any other way, there appears to be no equivalent.

**Vanishes on return.** The browser tab is created through
`openBrowserWorkspaceTab` (`features/review/ui/review-workspace-tabs.ts:66`).
Whether that tab is persisted across navigation was not traced. D29 is a
plausible contributor rather than the cause: if returning triggers a top-level
open, the forced `focus: { kind: "review" }` would reactivate Review over the
Browser tab — which would look exactly like the tab vanishing, while the tab
itself still exists.

Basic exploration only. Both halves need tracing before either is actionable.

## D31 — Only `http(s)` URLs are ever linkified; `file://` is inert everywhere

**Reported by the user:**

> why this link is not clickable in session that opens in sidebar

**Impact:** A path the agent hands the user cannot be acted on. They are told
where something is and then have to retype it somewhere else to reach it.

Two independent linkifiers both hardcode the scheme, so no non-`http(s)` URL is
ever clickable anywhere in the transcript.

**Markdown code spans** — `markdown.tsx:158-168`:

```js
const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string): string | undefined {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return undefined
  …
}
```

`codeUrl` is what promotes a URL inside a code span to an anchor (`:596-613`).
A `file://` URL fails `urlPattern.test()`, returns `undefined`, and the link is
never created — the text renders inert.

**Tool output / message text** — `message-part.tsx:613`:

```js
[...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
```

Same restriction, independently written, in a different package.

Both patterns are also anchored to schemes only. `file://`, `vscode://`,
`claxedo://` (which this app defines for documents — see
`mcp__claxedo__documents_open`) and any custom scheme are all equally invisible.

**A second layer exists underneath.** Even if the anchor were created, a renderer
running on an `http://` origin will refuse to navigate to `file://` — that is a
browser/Electron security rule, not an app bug. So making these clickable is not
a matter of widening the regex: it needs routing through the existing OS-open
path, `platform.openLink(url)` (`app/composition/agent-plugin-ports.tsx:83`),
rather than a plain anchor. D30's unresolved half is the same question for
`http` URLs.

Note this is a stricter policy than a deliberate allowlist would be — there is no
comment on either pattern explaining the scheme restriction, and the two were
clearly written independently rather than derived from one shared rule. Whether
`https?`-only is a security decision or an accident of the first case each author
had in mind is not recorded anywhere in the code.

Related: D30 (an `http` localhost URL was also not clickable), which suggests the
missing piece is the click routing, not just the pattern.

Read.

---

## D32 — Subagent chips spawn phantom rows, dead "Thinking" tabs, and unclickable chips

**Reported by the user:**

> clicking a subagent chip opens a tab that is stuck on "Thinking" — and there
> are six chips; are there really six subagents? One chip can't be clicked at
> all.

**Impact:** Clicking a chip opens a child-session tab whose transcript is
permanently empty — the user sees "Thinking" forever even though the subagent
finished. The chip row itself overstates the count: phantom rows render their
own chips, so the transcript claims more subagents than ever spawned, and some
of those chips are dead.

This is one user-visible bug with a pipeline of causes. All ten findings below
are confirmed by tracing the code, not guessed from symptoms.

### How the pipeline works today

`ClaudeDriver.runQuery` iterates SDK messages → `ingestClaudeSdkMessage` runs
two lanes per message (`driver.ts:647-674`):

- **Observation lane** — `claudeSubagentObservations(message)`
  (`agent-event-runtime/.../claude/adapter.ts:343`) extracts spawn/task/result
  observations → `observeSubagent` (`sdk-runtime-adapter.ts:579`) → the
  admission boundary (`subagent-admission.ts`) resolves which *row* the
  observation belongs to, allocates a `childSessionId`, persists to
  `session_subagent`, and publishes `subagent-updated` via `router.project` →
  parent projector → `publishRuntime` → SSE → `applySubagentRuntimeEventEnvelope`
  → `subagentRegistry.apply` → chips re-render.
- **Transcript lane** — `runtime.ingest` translates the message into runtime
  events → `router.project(event, source, route)` — child route when
  `parent_tool_use_id` is set. `createChildEventRouter` buffers unresolved child
  events (256 events / 1 MB / 30 s), replays them once `observeSubagent` calls
  `router.associate(toolCallId → child target)`, and drops + poisons them after
  TTL/limits/dispose.

The child's seeded turn: `observeSubagent` calls `store.startTurn` for the child
session (user message with the task description + assistant message +
`status: 'busy'`). Routed events append parts to that assistant message.
`store.finishTurn` runs only when `subagentOutcome()` sees a terminal
observation (`subagent-transcript.ts:56`).

UI: chip click → `claxedo:open-subagent` →
`workspacePanel.open({focus: {kind: "subagent", sessionId}})` →
`openSubagentWorkspaceTab` → `SessionPaneScope` + `SessionPage` docked in the
panel. The child's `statusQuery` reads `busy` → the timeline shows the
`Thinking` row because the turn is busy with no assistant parts.

### Confirmed defects

1. **The "Thinking" tab is a child session with an empty transcript.** The row
   isn't centered — it's left-aligned inside the centered `md:max-w-192 mx-auto`
   column; it *looks* centered because the pane is otherwise empty (the seeded
   user message renders a near-invisible empty bubble when the observation had
   no `description` — `sdk-runtime-adapter.ts:644` passes `parts: []`). The real
   bug is why it's empty.

2. **Child turn lifecycle events are dropped.** `sdk-runtime-adapter.ts:564`
   sets `onEvent: () => {}` on the child projector, and the `store.startTurn` /
   `store.finishTurn` return values at lines 636/672 are discarded. The store
   does not self-publish — only `eventHub.publishRuntime` feeds
   `/api/wr/runtime-events` (`events.ts:42`+). Consequences:
   - No `session.status` event ever fires for the child → its status is stale in
     the UI (stuck `busy`; "Thinking" can persist after the row completes).
   - The child assistant message's `time.completed` never publishes → the live
     UI sees a permanently unfinished turn.
   - The seeded user message never publishes (masked by refetch-on-open, so
     usually invisible).

3. **Task-only rows never bind `parent_tool_use_id`.** A row whose first
   observation is `background_tasks_changed` or a `task_*` event without
   `tool_use_id` binds only the `task_id` key. Nested messages carry the *Task
   tool_use id* → never match → buffered 30 s →
   `child_event_route_buffer_expired` → **poisoned**: the child transcript is
   permanently empty → the tab is "Thinking" forever even while the chip's
   status updates (`child-event-routing.ts:130,160-164`).

4. **Non-agent tasks become subagent rows.** `taskObservation` ignores
   `task_type`, `ambient`, and `skip_transcript` (`adapter.ts:389-433`).
   `local_bash` background commands, workflows, and internal housekeeping tasks
   all get `transcript: {kind: "messages"}` rows. Those without a `tool_use_id`
   are ambient → they render in the "Background subagents" section
   (`message-timeline.tsx:1958-1967`) — phantom chips whose seeded child
   sessions can never receive routed events → permanent "working" + "Thinking".

5. **`background_tasks_changed` is handled as an edge stream, but the SDK
   defines it as a replace-level snapshot** (`adapter.ts:417-429`). Every member
   emits `status: "running"`; a task that *leaves* the set is never marked
   terminal or removed → stale "working" rows forever. It can also fire before
   the assistant snapshot carrying the spawn, creating a task-keyed row before
   the tool-keyed row exists.

6. **Ambiguous association silently forks a new row.**
   `sole(associationMatches)` (`subagent-admission.ts:289-294`) returns
   `undefined` when an observation's keys match two different rows →
   `deterministicKey` mints a *third* row. Concretely: if `task_started` carries
   `[stable:task-N → row-B, tool:X → row-A]`, it creates row
   `subagent_hash(stable:task-N)` — three rows for one agent, each with its own
   seeded child session.

7. **`tool_use_result.agentId` is stamped on every `tool_result` block in the
   message** (`adapter.ts:374`). A user message batching multiple tool results
   produces an agent observation per block — each gets a "spawn" edge on the
   agent's row. For batched parallel Task results sharing one `agentId`, the
   second resolves via provider association into the *first* row → the first
   chip renders twice (no dedup in `SubagentChipRow` — `subagent-chip.tsx:106-108`
   flatMaps without deduping) and the second spawn row is stuck "working"
   forever.

8. **No live sweep when the parent turn ends.** `reconcileOrphanedSubagents`
   runs only at store construction (`store.ts:589`). `router.dispose()` at turn
   end drops unresolved buffers, and post-turn `task_notification`s for
   background agents only arrive on the *next* query — a row whose terminal
   event is missed or deferred stays "working" for the life of the process →
   **status never changes**.

9. **"Can't click."** The chip renders a `<span>` (not a button) when
   `resolution !== "ready"` (`subagent-chip.tsx:126,142-155`). That requires no
   `childSessionId` or transcript kind `none`/`unknown`
   (`subagent-presentation.ts:120-126`). For claude rows every observation is
   openable so a child is allocated — *except* rows created by transcript-less
   events (status-only/host events hitting a missing row) or hydrated rows
   persisted with `transcript_kind = 'none'`. The unclickable chip is almost
   certainly one of these degraded rows — consistent with the phantom-row
   producers above.

10. **On "are there really six"** — OS process count is meaningless (harness +
    probe + MCP processes exist regardless; `driver.ts:307,523`). The
    authoritative count is `GET /session/:id/subagents` / the `session_subagent`
    table. Every local `state.db` under `~/.claxedo` was checked — none contain
    the session (it likely ran in an unreachable workspace store, or was
    cleaned). Given findings 4–7, six chips can correspond to fewer real
    spawns — the "Claude-Agent / Delegated task" chip is the fallback
    label/description (`subagent-presentation.ts:116-117`), i.e., a row that
    never received a spawn observation carrying `subagent_type`/`description` —
    a phantom/split row, not a real spawn.

### Proposed fix direction (not implemented)

1. **`adapter.ts`**: filter `taskObservation`/`background_tasks_changed` to
   `local_agent` (skip `ambient`/`skip_transcript` tasks); treat
   `background_tasks_changed` as a snapshot — mark rows not in the set as
   terminal instead of only adding members; in the `user`-message branch, stamp
   `providerId` only on the block that actually is the agent result.
2. **`subagent-admission.ts`**: when `sole(associationMatches)` is ambiguous,
   prefer an explicit merge order (provider → stable → tool) or emit a
   diagnostic rather than minting a new row.
3. **`sdk-runtime-adapter.ts`**: emit the child's `startTurn`/`finishTurn`
   events on `publishRuntime` (or the compat lane) so the child session's
   status/completion is live; when a row has only a task-id binding, also
   associate the spawn `toolCallId` once known so buffered child events replay
   instead of expiring.
4. **`sdk-runtime-adapter.ts`**: on parent turn end, terminalize children still
   `running` (or at least emit a status sweep) rather than leaving them until
   next process start.
5. **`subagent-chip.tsx`**: dedupe chips by `subagentKey`.

Regression tests to add: parallel Task results in one user message,
`background_tasks_changed` membership removal, task row without `tool_use_id`,
and the child `finishTurn` event emission.

Read.
