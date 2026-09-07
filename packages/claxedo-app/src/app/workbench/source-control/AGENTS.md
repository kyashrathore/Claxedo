# Source Control

`SourceControlView` is the workspace panel's Changes navigator (`../rail/workspace-panel-body.tsx` mounts it in the files column when the panel navigator is `"changes"`): a commit box, the publish / push / Create PR actions, the **Compared changes** group while the pane reviews a `to-from` comparison, the **Staged Changes** and **Changes** groups, and the **Graph** of recent commits, for the workspace directory `useSDK()` is scoped to.

## What it owns

- `source-control-view.tsx`: the `data-testid="source-control-view"` column. Reads `workspaceGitStatusQueryOptions` and `workspaceGitLogQueryOptions` (`platform/files/workspace-git-status-query.ts`) through `sdk.git`, the runtime VCS summary (`workspaceVcsQuery`, for `default_branch`), the pane's review selection (`createReviewSelection` in `features/review/review-intent.ts`, scoped by `useSessionParams()`), and — while that selection is `to-from` — `workspaceDiffSummaryQueryOptions` (`platform/files/workspace-diff-summary-query.ts`) through a `createReviewDiffClient`. Writes through `useWorkspaceGitMutations()` (`../context/workspace-git-mutations`). Holds the commit message, the last write error, and the four collapse flags in memory only; the graph starts collapsed. `pending()` from the mutations makes the whole column inert (`.claxedo-source-control--busy`) and puts a spinner on the button of the action in flight. The Publish Branch / Push actions and the Create PR link are the shared `Button` (`variant="ghost" size="small"`) with their `SemanticIcon`s.
- Layout: the groups scroll in `data-testid="source-control-groups"` and the graph section sits under them. With the graph collapsed the groups take the column (`flex-1`) so the GRAPH header rests at the bottom; expanded, the groups cap at 65% of the column and the graph takes the rest, each scrolling on its own.
- `commit-box.tsx`: the message `textarea` (grows from one to six rows with the message's line count), the Commit split button — the shared `Button` (`variant="secondary" size="small"`) with the variants menu on a matching `DropdownMenu.Trigger as={Button}` (Commit, Commit & Push, Amend last commit). ⌘/Ctrl+Enter commits. Commit needs a non-blank message and a staged file; Amend needs only the message. The view clears the message after a successful commit and renders the write error under the box.
- `change-group.tsx`: `ChangeRow` is one file row — status letter in the diff colors, file name with its dimmed directory, `DiffChanges` counts, an optional trailing action. `ChangeGroup` is one collapsible group of `GitStatusEntry` rows with a hover / focus Stage or Unstage action per row and a Stage all / Unstage all action in the header. Rows hover `bg-surface-base-hover` and the active row is `bg-surface-base-active`. `SourceControlSectionHeader` is the shared section label (the rail's `rail-section-label` type: `text-xs font-medium uppercase tracking-normal text-text-weaker`) reused by the compare group and the graph; `active` lifts it to `text-text-base` for the group the pane's review currently shows (`data-active`).
- `compare-group.tsx`: the `data-testid="source-control-group-compare"` group of `WorkspaceDiffSummaryEntry` rows for the selection's `fromRef → toRef` (HEAD named after the checked-out branch, full hashes abbreviated), with a count badge, a skeleton while the summary loads, and "No changes" when it is empty.
- `commit-graph.tsx`: the commit listbox with a thin rail and a dot per row: subject, ref chips, short hash, author, relative time (`lib/relative-time.ts`). A row click selects that commit (`aria-selected`, `bg-surface-base-active`) by setting the review selection to `commitReviewSelection(commit)` — its first parent (the empty tree for a root commit) against itself; clicking the selected commit again returns the selection to `uncommitted`.
- `workspace-remote.ts`: `useWorkspaceRemoteUrl` — the workspace's git remote from the session inventory's `git.remote` (the source the rail labels projects from) or the workspace catalog's `repo_url` / `git.remote`; `githubOwnerRepo` and `githubCompareUrl` build the Create PR link, which only exists for a GitHub remote.

## Selection

The review selection is the pane preference `features/session/preferences/pane.ts` persists (`{ mode, fromRef?, toRef? }` per pane scope): the Review tab, its compare pill, and this column read and write the same entry, so a pick in any of them shows in all three.

A row click calls `onFileClick(path, mode)` with `"staged"`, `"unstaged"`, or `"to-from"`; the panel body turns that into `workspacePanel.retarget({ navigator: "changes", focus: { kind: "file", path, intent: "review", reviewMode } })`, and `features/review/ui/review-tab.tsx` switches into that mode before revealing the file. `activePath` comes back from the panel's focus and highlights the row.

## Must not import

Rail surfaces (`rail-sidebar`, `workspace-panel-body`), routes, and feature providers. `../rail/rail-git-remote` is the one rail module it reads, for `parseOwnerRepo`.

```json
{
  "owns": "SourceControlView: the workspace panel's Changes navigator — commit box, publish / push / PR actions, compared, staged and unstaged groups, commit graph",
  "writerOf": [],
  "mustNotImport": [
    "@/app/routes/*",
    "@/app/workbench/rail/rail-sidebar*",
    "../rail/rail-sidebar*",
    "../rail/workspace-panel-body*",
    "@/features/processes/providers*",
    "*/features/processes/providers*"
  ]
}
```
