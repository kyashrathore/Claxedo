# Transcript corpus

The corpus holds the transcript's behavior still: every case renders the same as its recorded baseline. Flow 30 (`e2e/flows/30-transcript-corpus.spec.ts`) replays each case through the harness's scripted agent, opens it, and compares screenshots, the accessibility tree, and the scroll position after each scripted interaction.

## Files

- `case.ts`: the shape of a case (`CorpusCase`).
- `cases/*.json`: one case per file, named by its `id`.
- `seeds/transcript-lab-fixture.json`: five recorded sessions (`diagnosis`, `toolrun`, `cfdeploy`, `landing`, `onboarding`) in the runtime-contract shape; `cfdeploy` is the long one (90 prompts, 3.8 MB). A case can slice a seed instead of carrying its own transcript.
- `FIXES.md`: the ledger of fix commits, each mined into a case or marked as covered.
- `COMMENTS.md`: the triage of every comment in the moved files: a case, a README invariant, or a deletion.

## A case

```json
{
  "id": "worked-turn-folds",
  "title": "A settled turn with work folds under its Worked header",
  "source": { "kind": "inventory", "ids": ["SESS-025", "SESS-038", "SESS-039", "SESS-040"] },
  "partKinds": ["reasoning", "tool:read", "tool:execute", "text"],
  "replay": {
    "agent": "acp",
    "turns": [
      {
        "prompt": "Check the project.",
        "steps": [
          { "kind": "reasoning", "text": "Looking around the project" },
          { "kind": "tool", "tool": "read", "title": "Read README.md", "locations": [{ "path": "{{workspace}}/README.md" }], "text": "corpus\n" },
          { "kind": "text", "text": "All checked here." }
        ]
      }
    ]
  },
  "ready": "All checked here.",
  "interactions": [{ "kind": "toggleFold", "turn": 0 }],
  "invariant": "The turn opens folded under 'Worked for …' and unfolds into its work groups."
}
```

- `source` says where the case came from: an inventory row (`inventory/session.md`), a seed session, a fix commit, a comment, or a session-ui unit test.
- `partKinds` lists what the transcript contains, so the corpus can be checked for every part kind the agents produce.
- `replay.turns` are played in order through the scripted ACP agent; each turn's `steps` are an `AcpStep[]` (see `e2e/README.md`), and `{{workspace}}` becomes the case's workspace folder. A turn with an `error` step is sent without waiting and settles when its assistant message completes or fails.
- `replay: { "agent": "claude", "scenario": "child-message-event" }` runs the native Claude CLI against the scripted model boundary, creates a background Agent, and receives its SendMessage delivery.
- `replay: { "agent": "claude", "scenario": "host-child-followup" }` sends two turns through a Claxedo-created child and verifies both attributed parent wakes and their persisted results after reload.
- `ready` is text the last turn shows; the case waits for it before comparing.
- Turns are sent with ascending message ids, as the app sends them: the app orders a transcript by message id, and the runtime gives a prompt without one a random id.
- A session opens on its first page: every turn arrives with every part, each tool as its row header unless the reader's settings open it, and a turn the fold folds is drawn under its "Worked for …" header. Nothing is read after it until the case acts.
- A turn marked `"live": true` streams with the session open: it is sent once the transcript is on screen, and its steps pace their text with `delayMs` and stop at `hold` steps. The case compares what is on screen at each hold, so it proves the streaming renderer, not only the settled one. A live case's durations (the text part's agent and time, the Worked header's label) are hidden from its screenshots and replaced in its trees, since they depend on how long the holds lasted.
- `interactions` run in order after the transcript is on screen, and the comparison is taken after each one:
  - `scroll` to `top` or `bottom`, `toggleFold` of the n-th Worked header, `reload`;
  - `toggleUserMessage` expands or collapses the user bubble containing the stable visible text in `message`;
  - `toggleAgentMessage` expands or collapses the child-message details row containing the report text in `message`;
  - `release` a live turn's `hold`, wait for its `ready` text and a DOM that has stopped changing, and, with `settles`, for the session to go idle;
  - `markRows` remembers the turn rows on screen, and `rowsKept` asserts they are still the same elements;
  - `markDetached` counts, after a forced collection, the DOM nodes that live outside the document, and `detachedGrowth` asserts that count grew by at most `max` since.
- `invariant` is the sentence the case protects, so a failing comparison reads as a behavior, not a pixel.

## Running

Compare against the recorded baseline, or record a new case's:

```sh
bun run e2e -- e2e/flows/30-transcript-corpus.spec.ts --update-snapshots=none
bun run e2e -- e2e/flows/30-transcript-corpus.spec.ts --update-snapshots=all
```

The baseline lands in `e2e/flows/30-transcript-corpus.spec.ts-snapshots/`, per project (`web`, `phone`) and platform. The macOS web baseline is committed. Font rendering differs per machine, so re-record it on the machine that compares, and record a platform or project that has none; a run without a recorded baseline fails and names the command. Differences land in `e2e/results/` as expected, actual and diff images.

## What must match

After opening and after every interaction, once the DOM has been quiet for 700 ms (a diagram or a highlight upgrade lands after the text it belongs to), for every rendered turn (`[data-component="session-turn"]`, the timeline's own row): its screenshot and its accessibility tree, plus the count of rendered turns and the scroll element's `scrollTop`. A difference needs the owner's sign-off, recorded next to the case.
