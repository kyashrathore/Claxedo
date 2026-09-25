# Streaming slice for sign-off: `v2/stream-slice` at dfbf6093da

**What it is.** Four transcript fixes that make a streaming reply cheaper to render, each with a transcript-corpus case that compares v2 against today's app while the reply is still streaming. The branch is cut from `v2/exp-stream` (feat/app-v2 plus the delta fix, which is already on feat), and feat is merged in last. It is not merged into feat.

**The result**, measured with the bench in this slice:
- Scenario: 22 earlier turns, then a 12k-character reply streamed around four tool calls.
- Method: three builds on one stack, run in alternating order, two runs each.
- The first number is feat/app-v2 (which already has the delta fix); the second is this slice. Today's app (v1) is in brackets.

| | 1x CPU | 4x CPU |
|---|---|---|
| Delta arrival to paint, median | 9.0–9.2 → 8.2–8.5 ms (v1 5.7) | 13.9–14.1 → 10.9–11.5 ms (v1 13.7) |
| Frames over 16.7 ms | 0–2 → 0 (v1 0) | 21–31 → 13–14 (v1 16) |
| Main thread busy | 13.1–14.1% → 10.3–11.2% (v1 17.7–18.5%) | 45.6–50.4% → 28.0–35.2% (v1 66%) |
| Script | 4.5–4.9% → 2.8% (v1 7.9–8.0%) | 17.0–18.1% → 8.2–9.4% (v1 33.4%) |
| Garbage collection | 200–211 → 112–121 ms (v1 244–250) | 357–418 → 257–271 ms (v1 377) |
| Heap after a forced collection | 37.3–37.7 → 16.7–16.8 MiB (v1 42.8–43.4) | 37.3–37.7 → 16.7–17.0 MiB (v1 43.3) |
| DOM nodes after a forced collection | 48.6k → 3.7k (v1 48.7k) | 48.6k → 3.7k (v1 48.8k) |

- One v1 run at 4x stopped following the stream (it ended 5,964 px above the end), so it is left out. This has happened in two separate benches.
- Raw data: `slice1/` and `slice4/` in `/private/tmp/claude-501/-Users-yashvardhansingh-test-opencode/b8fc7026-28c0-4b62-97e7-6646f6620b5a/scratchpad/perf/exp-stream/` (JSON, CPU profiles, heap profiles). Source maps are in `dists/v2feat` and `dists/v2slice` there.

**Checks run on the slice tip:**
- The whole corpus (flow 30) plus flows 03, 04, 09 and 11 on web and phone: 37 passed, both before and after the final merge of feat/app-v2 9a9f077d17. The benchmark ran on the tip before that merge; the merge brought no change to the four files the slice edits.
- 7 were skipped. Those are flows 04, 09 and 11 on phone, which the specs themselves skip ("runs at desktop width").
- Typecheck and the e2e typecheck pass.
- No added comments. The e2e-hygiene check has no new violations; the 3 it reports are in flows 10 and 31.

## Commits, in order

### 1. `6877ff1ab5` The bench: `bun run e2e:perf-stream`
- **What it does:** one isolated stack serves each variant from its own origin. The scripted agent paces its text with a new `delayMs` option. It records:
  - per-delta arrival to paint;
  - frame intervals and long animation frames;
  - main-thread, script, style and layout time;
  - a CPU profile;
  - heap and DOM nodes after a forced collection;
  - optionally, a sampled heap profile and a timeline trace.
- **Waits:** it waits on a quiet DOM and an idle session, never on a timer, so it passes e2e-hygiene. The e2e README has a new section on it.

### 2. `26a8392bbb` and `348907306b` The corpus replays a live turn
- **Why:** until now every corpus case was settled before the app opened, so the streaming renderer was never compared with today's app.
- **Live turns:** a turn marked `"live": true` starts once the session is on screen and stops at `hold` steps. A `release` interaction lets it continue and waits for its ready text and a quiet DOM; with `settles`, it also waits for the session to go idle. The comparison is taken at every hold.
- **New checks:**
  - `markRows` and `rowsKept` check that the same row elements are still on screen;
  - `markDetached` and `detachedGrowth` limit how many DOM nodes are left detached after a forced collection. v2 sits at about 3,000 detached nodes before anything streams, so the limit is on growth, not on the total. Today's app leaks here, so the check is skipped on v1.
- **Durations:** turn durations vary with how long the holds lasted. In live cases they are hidden in screenshots and replaced with a placeholder in the accessibility trees.

### 3. `3a49d90afb` B2: only the open block is re-lexed
- **What it changes:** `markdown-stream.ts` `project()` used to lex the whole message on every delta. It now lexes from the start of the open block and keeps the closed blocks. Text that contains a reference definition still lexes the whole message.
- **Before → after:**
  - Projection alone: 6.2 → 0.27 ms per delta at 12k characters, and 32.5 → 0.68 ms at 37k. The old cost grows with the square of the length.
  - marked.lex per stream at 4x: 630–660 → 310–365 ms.
  - One 25k-character reply at 1x: 405–488 → 98–128 ms.
- **Equivalence:** the incremental path gives the same blocks as lexing the whole message on 44,963 streamed prefixes over 26 texts (the bench replies, the corpus texts, setext headings, tables, lists, fences and reference links).
- **Corpus case `stream-prefixes`:**
  - It holds a live reply after a setext line, inside a table row and inside a list, then lets a late reference definition arrive.
  - At every hold it matches today's app on web and phone.
  - **Red run:** lexing from one character past the open block's start fails at the first hold; the ready text "Setext title" never appears.
  - The commit message says the red run failed on "alpha". That is wrong; it was "Setext title". I did not amend the commit.

### 4. `fe03c2be39` B1 + C: the open block is parsed once, and controls are built on the committed DOM
**B1, the problem:** every delta parsed and sanitized the open block twice. The render effect painted it with the sync parser, and the resource then parsed the same text again.

**B1, the fix:**
- The resource reuses the render effect's block for the open block.
- Blocks that have closed still get the async upgrade (math, highlighted code).
- The sync block keeps a hash that differs from the async one, so the upgrade still replaces the sync paint. My first prototype gave both the same hash, and that silently skipped the upgrade; flows 03 and 30 caught it.

**C, the problem:**
- Every delta decorated a freshly parsed copy of the block.
- A streaming table got a new copy button and a new full-screen button each time, each one a Solid root.
- morphdom then threw that copy away without disposing them.

**C, the fix:**
- Structural decoration stays on the parsed copy.
- The controls are created once on the committed DOM and kept across morphs.
- The full-screen button reads the table when it is clicked.
- The copy button's labels compare by value.

**Before → after** (4x, inclusive ms per stream, taken from the prototype run):

| | Before | After |
|---|---|---|
| markdown resource | 2,700–2,900 | 950–1,075 |
| sanitize | 1,070–1,240 | 755–780 |
| decorate | 630 | 43–54 |
| Icon | 620 | 8–12 |
| Tooltip | 510–530 | 33–40 |
| updateBlock | 1,600–1,700 | 780–900 |
| heap after a forced collection | 37 MiB | 16.7 MiB |
| DOM nodes | 48.6k | 3.7k |

- Heap sampling traced 15.9 of the 22 MiB still alive after a forced collection to ensureTableWrapper → createCopyButton/createViewButton.
- Today's app has the same leak.

**Corpus cases:**
- **`stream-upgrade`:** holds the reply after a formula and a fenced block have closed.
  - Red run: giving the sync block the async block's hash leaves the formula unrendered; the first stage differs by 1,503 px.
- **`stream-table-controls`:** holds a table mid-stream, then lets it settle.
  - The detached DOM may grow by at most 300 nodes.
  - Red run without this commit: 9,906.

### 5. `57e97f4fa2` D: timeline rows track whether a part has text, not the text
- **What it changes:** the turn's row memo read every text part's text, so every delta rebuilt every row of the turn. Rows now depend on a per-part "has text" memo, and the fold count copies the part without tracking it.
- **Before → after** (4x):
  - constructMessageRows: 756–920 → 23–27 ms per stream;
  - the event batch's reactive work: 5.4–6.3 → 3.5–4.2 s;
  - script time: 15.4–16.9% → 10.3–12.9%.
- **Corpus case `stream-rows-stable`:**
  - After a tool call, a text part opens with only whitespace and then grows across two holds.
  - Its row appears once it has text, and every row marked before the deltas is the same element afterwards, as in today's app.
  - **Red run:** a "has text" memo that never re-reads the text never shows the answer; the ready text "halfway" is not found.

### 6. `2b4e52c92c` F: one markdown purifier, configured once
- **What it changes:** DOMPurify re-parsed its config into new allow-lists on every call. A dedicated instance now takes the config once through `setConfig` and carries the `rel=noopener` hook.
- **Measured on its own** (4x, three alternating runs each, the slice with and without this commit):
  - sanitize: 963–1,042 → 630–832 ms per stream (median 970 → 731);
  - sync render of the open block: 1,144–1,252 → 801–1,082 ms.
- **Corpus case `sanitized-links`:**
  - Web and mail links keep their targets, a `javascript:` link and raw markup stay inert text, and math still renders, as in today's app.
  - **Red run:** a purifier config without the MathML profile drops the formula from the accessibility tree.

## Dropped: E (a single owner for follow-at-end)
- **The idea:** remove the timeline's own `scrollToEnd` after each row resize and rely on virtual-core's `anchorTo: "end"`.
- **Why it was dropped:** at 4x it moved the forced layout into the frame's own layout pass without lowering busy time. The saved diff is `E-one-end-anchor-with-comments.diff`.
- **What the follow-at-end case found:** v2 ends 72–76 px above v1's scrollTop on a long streamed reply, **with or without E**. Both apps sit at their own end, so the content heights differ. This is an existing parity difference and was not investigated further, so the case is not in the slice.

## Found while building the cases (today's app; the slice keeps v2 identical to it)
- **Unresolved early reference link:** a reference link cited before its definition streams in stays as raw `[the docs][1]` after the turn settles. The closed block's cached HTML is keyed by its raw text, not by its source with the definitions added. The `stream-prefixes` baseline records this.
- **Stray paragraph from a split `$$`:** when a `$$` math fence is split across deltas, v1 sometimes leaves a stray `$$ ormula.` paragraph after completion. It varied between runs, and I did not check whether v2 does the same. `stream-upgrade` sends the formula in one delta so its baseline is stable.
- **Unexplained v1 corpus failure:** in about 12 recording runs, one v1 run of `stream-prefixes` failed against its own baseline. The failure details were overwritten and the cause is undiagnosed. Four repeat runs after that passed.

## Left for later
- **Latency at 1x:** the median delta still paints about 2.5 ms later than in v1 (8.2–8.5 vs 5.7 ms). I did not measure the cause.
- **Remaining long frames at 4x:** they come from mounting a new tool card, the first Mermaid render, and the settle read when the turn ends.
