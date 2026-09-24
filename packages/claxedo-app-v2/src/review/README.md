# Review

Owns: the Changes panel tab. It shows the diff of a placement for a scope, turns line comments into context for the agent, and runs commit, push and worktree creation.

## Owned concepts

- **Scope** (`model.ts`): what the diff compares. `uncommitted`, `staged`, `unstaged`, `branch(base)`, `branchWorktree(base)` or `range(from, to)`. Choosing a scope collapses every file.
- **Diff document** (`view/review-diffs.tsx`): the transcript's `ReviewCodeView`, the one diff renderer in the app, over `server.queries.git.diff`. A file's patch loads only when the view asks for it (`diff-content.ts`, at most 64 files per scope), through `server.queries.git.diffFile`. Media files and diffs over 500 changed lines show a notice instead of a diff; "Render anyway" lifts the guard for that file.
- **Line comment** (`comments.ts`): a comment on a line range, written for the agent. Its only home is the focused session's composer draft, as a file context item with `commentOrigin: "review"`. The review derives its annotations from that draft; removing the chip in the composer removes the comment here, and sending the prompt sends it. With no session in the URL, the diff is read-only.
- **Commit** (`view/commit-box.tsx`): every changed file is included unless the user excludes it. Commit stages the included files, unstages staged files the user excluded, then commits the message. Push publishes the branch when it has no upstream.
- **Worktree** (`view/worktrees.tsx`): a new worktree placement of the same project, from a base ref.
- **Diff style**: unified or split, one preference for the user.

## State machines

- **Diff load**: the summary query drawn as `loading`, `failed` (with retry) or `ready`; `ready` with no files offers the branch diff against the default base.
- **File body** (`diff-content.ts`): `media`, `large`, `loading`, `failed` (with retry) or `ready`.
- **Flows** (`model.ts`): commit `idle → running(staging | committing) → done(hash) | failed(error)`, push `idle → running(pushing) → done(remote, branch) | failed(error)`, worktree `idle → running(creating) → done(placement) | failed(error)`. Git error codes (`git_empty_message`, `git_nothing_staged`, `git_conflict`, `git_push_rejected`, `git_timeout`) have their own copy.

## Invariants

- Diffs, status, refs and bases are the adapter's query data, refreshed only by its `filesChanged` invalidation. Nothing here copies them.
- `ReviewProvider` holds the per-placement view state (scope, open files, exclusions, forced files, the commit message). It mounts inside the scoped shell, so that state survives switching panel tabs.
- A comment's range is stored without its diff side until the composer's file context item carries one, so a comment on a deleted line is drawn on the additions side.

## Commands

`review.toggleDiffStyle`, while the Changes tab is open.

## Flows

Flow 14 (diff, a line comment reaching the agent, commit, push to a local bare remote, worktree) and flow 33 (phone).
