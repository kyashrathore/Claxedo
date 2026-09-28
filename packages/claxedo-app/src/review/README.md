# Review

Owns: the workspace panel's Review tab and its Changes column, ported from v1. The Review tab shows the diff of a placement for a scope and turns line comments into context for the agent; the Changes column stages, unstages, commits, pushes and walks the commit graph.

## Owned concepts

- **Scope** (`intent.ts`, `model.ts`): what the diff compares. `uncommitted`, `staged`, `unstaged`, `branch(base)`, `branchWorktree(base)` or `range(from, to)`, shown in v1's terms (`ReviewMode` with `fromRef`/`toRef`). Choosing a scope collapses every file. Selecting a commit in the graph reviews it against its first parent (or the empty tree).
- **Review tab** (`view/review-tab.tsx`): v1's toolbar portals into the panel's L2 row (`view/review-toolbar.tsx`): the compare trigger with its file count and tooltip, the compare menu (`view/compare-menu.tsx`, `view/compare-list.tsx`: search, modes, branches, remote branches, tags, commits, and a Base view), the totals, "Expand all" / "Collapse all" and the diff style toggle ("d" toggles it while the tab is visible). The diff is the transcript's `ReviewCodeView` over `server.queries.git.diff`; each row's header and body are v1's (`view/review-file-row.tsx`): the path, the change summary, and on the hovered row "Copy", the chevron and "Open file". An empty review shows the mark, "No changes for this review mode", the branch diff offer and the placement's folder.
- **Row bodies** (`diff-content.ts`, `requested-files.ts`): a file's patch loads only when the view asks for it (the 64 most recently asked-for files per scope) through `server.queries.git.diffFile`, one query per file through `keyedQueries` (`src/lib/keyed-queries.ts`), read by file name rather than by position, so reordering the asked-for list never hands a row another file's patch; media files load their current bytes through `server.queries.files.content`. Diffs over 500 changed lines wait behind "Render anyway". A failed load shows its message and "Retry loading diff".
- **Line comment** (`comments.ts`, `view/code-view-comments.tsx`): a comment on a line range, written for the agent. Its only home is the focused session's composer draft, as a file context item with `commentOrigin: "review"`. Removing the chip in the composer removes the comment here, and sending the prompt sends it. With no session in the URL, the gutter is off.
- **Changes column** (`view/source-control-view.tsx`): the commit message and split commit button ("Commit", "Commit & Push", "Amend last commit"; commit needs a message and staged files), the push row ("Publish Branch", "Push N" or "Up to date"), the compared files while the scope compares refs, "Staged changes" and "Changes" with stage and unstage, and the collapsed "Graph" of the last 50 commits. A row opens its diff in the Review tab in that group's scope. Its section headers are the app's group labels (`sidebar-section-label`) with the count beside them; rows (`view/change-row.tsx`) take the sidebar row's height, radius and type size (`sidebar-row`) and show the file-type icon the diff list shows, the file name first, its folder after it truncated from the start so the nearest folders stay, the counts muted with a zero left out (`view/change-counts.tsx`, which the toolbar totals also use), and the status letter in quiet grey except a deleted file (the deletion color, the name struck through) and a conflict (the critical color). The message box is the kit `Textarea` and the push actions are muted ghost buttons.
- **Git actions** (`git-actions.ts`): one `@/lib/flow` for stage, unstage, commit and push, so the column knows which one runs and shows the last failure under the commit button.
- **Diff style**: unified or split, one preference for the user.
- **Loaded-diff identity** (`loaded-diff-identity.ts`): the sorted paths whose diffs the Review tab has loaded, written as its `data-review-loaded-diff-identity`. The benchmark driver computes the value it waits for with the same function.

## Invariants

- Diffs, status, log, refs and bases are the adapter's query data, refreshed by its invalidation after every git action and by `filesChanged`. Nothing here copies them.
- `ReviewProvider` holds the per-placement view state (scope, open files, forced files, the commit message, the Changes sections and their scroll position). It mounts inside the scoped shell, so that state survives closing the panel and switching its tabs.
- A comment's range is stored without its diff side until the composer's file context item carries one, so a comment on a deleted line is drawn on the additions side.
- `ReviewCodeView` reports its rendered rows on every render and scroll frame. Asking again for files already at the front of the requested list writes nothing, because a write rebuilds every row's content query and re-renders the list.
- Git error codes (`git_empty_message`, `git_nothing_staged`, `git_conflict`, `git_push_rejected`, `git_timeout`) have their own copy (`gitErrorCopy`); any other failure shows the app's copy for its error class.

## Flows

Flow 14 (the diff, a line comment reaching the agent, stage, commit, push to a local bare remote) and flow 33 (phone).
