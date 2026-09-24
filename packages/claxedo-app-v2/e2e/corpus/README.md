# Transcript corpus

The corpus is the proof that the transcript moved without changing: every case renders the same in today's app and in v2. Flow 30 (`e2e/flows/30-transcript-corpus.spec.ts`) replays each case through the harness's scripted agent, opens it in both apps, and compares screenshots, the accessibility tree, and the scroll position after each scripted interaction.

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
- `ready` is text the last turn shows; the case waits for it before comparing.
- Turns are sent with ascending message ids, as the app sends them: both apps order a transcript by message id, and the runtime gives a prompt without one a random id.
- A session opens on the latest turn's text-only surface, then reads the whole turn. The case holds that full read until the first turn row paints, so both apps always paint the surface first; a turn with work then keeps its "Worked for …" header, as it does on a real machine, where the surface wins that race.
- `interactions` run in order after the transcript is on screen (`scroll` to `top` or `bottom`, `toggleFold` of the n-th Worked header, `reload`); the comparison is taken after each one.
- `invariant` is the sentence the case protects, so a failing comparison reads as a behavior, not a pixel.

## Running

Today's app is the baseline. Record it, then compare v2 against it:

```sh
bun run e2e -- --app=v1 e2e/flows/30-transcript-corpus.spec.ts --update-snapshots=all
bun run e2e -- --app=v2 e2e/flows/30-transcript-corpus.spec.ts --update-snapshots=none
```

The baseline lands in `e2e/flows/30-transcript-corpus.spec.ts-snapshots/`, per project (`web`, `phone`) and platform, and is not committed: font rendering differs per machine, so both runs happen on the same machine. A v2 run without a recorded baseline fails and names the command. Differences land in `e2e/results/` as expected, actual and diff images.

## What must match

After opening and after every interaction, for every rendered turn (`[data-component="session-turn"]`, the moved timeline's own row in both apps): its screenshot and its accessibility tree, plus the count of rendered turns and the scroll element's `scrollTop`. The turn rows exclude the session title, which the owner removed from v2. A difference needs the owner's sign-off, recorded next to the case.
