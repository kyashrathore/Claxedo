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
  "id": "fold-count-never-drops-on-a-later-read",
  "title": "A turn folded on a partial read keeps its fold count when the full read finds fewer groups",
  "source": { "kind": "comment", "file": "src/session/view/timeline/message-timeline.data.ts", "line": 213 },
  "partKinds": ["text", "tool:read", "tool:edit"],
  "seed": { "fixture": "transcript-lab-fixture", "session": "cfdeploy", "turns": { "from": 10, "to": 14 } },
  "status": "idle",
  "replay": { "agent": "acp" },
  "interactions": [{ "kind": "reload" }, { "kind": "scroll", "to": "top" }, { "kind": "prepend" }],
  "invariant": "The fold row's count does not shrink after the reload's full read."
}
```

- `source` says where the case came from: a seed session, a fix commit, a comment, or a session-ui unit test.
- `partKinds` lists what the transcript contains, so the corpus can be checked for every part kind the agents produce (`text`, `reasoning`, `tool:<name>`, `file`, `compaction`, `handoff`, `agent`, `question`, `permission`, ...).
- `transcript` carries the messages and parts inline; `seed` points at a seed session and an optional turn range instead. A case has one of the two.
- `status` is the session status the case ends in; `working` and `retrying` cases render the live rows.
- `replay` names the route: the scripted ACP agent (the default), a real Claude or Codex CLI behind the scripted model server, or `unsupported` with the reason, for part kinds no route can produce yet. Unsupported cases still render from their inline transcript in both apps through a recorded session directory.
- `interactions` run in order after the transcript is on screen; the comparison is taken after each one.
- `invariant` is the sentence the case protects, so a failing comparison reads as a behavior, not a pixel.

## What must match

Screenshots at desktop width and in the `phone` project, the accessibility tree of the timeline root, and `scrollTop` of the timeline's scroll element after every interaction. A difference needs the owner's sign-off, recorded next to the case.
