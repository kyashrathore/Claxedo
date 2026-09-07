---
title: "feat: source-control Changes tab — commit box, staged and unstaged groups, publish, PR, graph"
status: proposed; implementation starting
type: feat
date: 2026-09-07
baseline: f2284f1fdd (feat/navigator-placement-sidebar)
package: packages/workspace-runtime, packages/claxedo-app
backward_compatibility: none — the flat Changes list in the navigator sidebar is replaced; the panel-placement navigator column and the Review mode selector are unchanged
related: ./2026-09-07-002-feat-navigator-placement-sidebar-plan.md
---

# feat: source-control Changes tab

## Overview

The navigator sidebar's Changes tab becomes a source-control view in the shape of VS Code's: a commit message box with a Commit button and a variants menu, Publish Branch and Create PR actions, a **Staged Changes** group and a **Changes** group with status letters and hover stage/unstage actions, and a **Graph** section listing recent commits. The user no longer picks between "uncommitted", "staged" and "unstaged" to see what is going on; both groups are always visible and a file click opens its diff in the Review panel in the matching mode.

## Problem Frame

Today the Changes tab is a flat list built from `/api/wr/file/status`, which folds index and worktree into one delta ([file.ts:121](../../packages/workspace-runtime/src/workspace-files/file.ts#L121)): it cannot tell a staged file from an unstaged one, reports staged-added files as modified, and lists a deleted file twice. Every git write is missing at the API layer: the only commit route commits a single clean file for the documents editor ([git-source.ts:38](../../packages/workspace-runtime/src/routes/git-source.ts#L38)). Recent commits exist only as `{hash, subject}` inside the ref picker ([diff.ts:559](../../packages/workspace-runtime/src/workspace-files/diff.ts#L559)).

## Requirements Trace

- One status route returns branch, upstream, ahead/behind, and separate staged and unstaged entries with per-file status and line counts, from one `git status --porcelain=v2` pass.
- Stage, unstage, commit (with amend), and push routes on the workspace runtime, each refusing workspace viewers, each invalidating the app's file-status cache on success.
- A commits route with author, date, refs and parents for the graph.
- The Changes tab renders: commit box (multi-line message, ⌘⏎ commits, Commit button, menu with Commit, Commit & Push, Amend), Publish Branch (no upstream) or Push (ahead > 0), Create PR (GitHub remote only; opens the compare URL), Staged Changes (n) and Changes (n) groups with A/M/D/U/R/C letters and hover Stage / Unstage / Stage all / Unstage all, and a Graph section.
- A file click opens the Review panel focused on that file in mode `staged` or `unstaged`.
- The classic panel-placement navigator column and the Review toolbar's mode selector are unchanged.
- Strings in every locale; parity test green.

## Key Technical Decisions

1. **New read route, not a widened `/file/status`.** `GET /api/wr/git/status` is additive; the existing route keeps serving the panel column and the review summaries.
2. **Writes live beside `GitSourceRoutes`** in a new `routes/git-worktree.ts`, calling `runGit` from `src/git.ts`, wrapped in `denyWorkspaceViewers`. The same code path serves local and cloud.
3. **Create PR is a compare URL**, `https://github.com/{owner}/{repo}/compare/{default}...{branch}?expand=1`, opened externally. No token in the browser.
4. **Publish uses the runtime's inherited credentials**; when the push fails with an auth error the UI shows the error and offers a terminal with the same command.
5. **The graph is a list with a rail**, not a drawn DAG: hash, subject, author, relative time, ref chips.
6. **Cache honesty**: every successful write calls the existing file-status invalidation owner and refetches the git status and commits queries.

## Contract (both lanes build against this)

```ts
// packages/workspace-runtime/src/client.ts — `git` namespace
type GitStatusEntry = {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"
  additions: number
  deletions: number
  from?: string // renamed
}
type GitWorktreeStatus = {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
}
type GitCommitSummary = { hash: string; shortHash: string; subject: string; author: string; date: string; refs: string[]; parents: string[] }

git.status(): Promise<GitWorktreeStatus>                                   // GET  /api/wr/git/status
git.stage(input: { paths: string[] }): Promise<void>                      // POST /api/wr/git/stage
git.unstage(input: { paths: string[] }): Promise<void>                    // POST /api/wr/git/unstage
git.commitStaged(input: { message: string; amend?: boolean }): Promise<{ commit: string }> // POST /api/wr/git/commit-staged
git.push(input: { setUpstream?: boolean }): Promise<{ remote: string; branch: string }>    // POST /api/wr/git/push
git.log(input?: { limit?: number }): Promise<{ commits: GitCommitSummary[] }>              // GET  /api/wr/git/log?limit=
```

Errors: 400 `git_empty_message`, 400 `git_nothing_staged`, 403 viewer, 409 `git_conflict` (merge in progress), 502 `git_push_rejected` with the git stderr in `message`.

## Implementation Units

- [ ] **Unit A: runtime routes and client** — owner `packages/workspace-runtime/src/{routes/git-worktree.ts (new), workspace-files/git-worktree.ts (new), client.ts, workspace/core.ts}` + tests beside the existing `git-source` tests. Status from `git status --porcelain=v2 -z --branch --untracked-files=all` plus `diff --numstat` and `diff --cached --numstat`. Log from `git log -n <limit> --format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P`. Done when every route has a test against a temp repo covering the positive flow, the viewer refusal, empty message, nothing staged, and a rejected push.
- [ ] **Unit B: app data** — owner `packages/claxedo-app/src/platform/runtime/workspace-git-client.ts (new)`, `app/providers/sdk/sdk.tsx` (expose `git`), `platform/files/workspace-git-status-query.ts (new)`, invalidation hook-up in `app/workbench/context/workspace-vcs-cache-honesty.tsx`. Done when queries and mutations exist with tests and a write refetches status, commits and the file-status cache.
- [ ] **Unit C: the view** — owner new `packages/claxedo-app/src/app/workbench/source-control/` (`source-control-view.tsx`, `commit-box.tsx`, `change-group.tsx`, `commit-graph.tsx`, `source-control.css`, vitest), `app/workbench/navigator-sidebar/navigator-sidebar.tsx` (mount it for the Changes tab), semantic icons `staged`/`commit`/`push`/`pullRequest` in `ui/semantic-icon.tsx`, i18n in every locale. Done when the vitest covers: groups and counts, letters, stage/unstage calls, commit enabled only with a message and staged files, Publish vs Push vs up-to-date, Create PR hidden without a GitHub remote, ⌘⏎ commits, a file click retargets the panel with the matching mode focus, graph rows.
- [ ] **Unit D: proof** — extend `core-navigator-sidebar.spec.ts` with: seeded repo with one staged and two unstaged files → groups and counts; stage one → moves group; commit with a message → both groups shrink and the graph gains the commit; Create PR hidden for a repo without a GitHub remote.

## Definition of Done

- [ ] `GET /api/wr/git/status` splits staged and unstaged with correct letters for added, modified, deleted, renamed, untracked and conflicted files, and reports branch, upstream, ahead and behind. Progress:
- [ ] Stage, unstage, commit-staged (with amend) and push work through the runtime for a local workspace and refuse viewers. Progress:
- [ ] The Changes tab renders the commit box, actions, both groups with hover actions, and the graph; a file click opens its diff in the matching review mode. Progress:
- [ ] Every successful write refetches the status, the commits and the file-status cache. Progress:
- [ ] Create PR opens the compare URL only when the remote is GitHub. Progress:
- [ ] All locales carry the new strings; parity test green. Progress:
- [ ] Typecheck, both app runners, the workspace-runtime tests, the ratchets and the extended e2e spec are green, with commands recorded. Progress:

## Execution

Wave 1, two agents concurrently: Unit A (runtime) and Unit C (view, against the contract with a mocked client). Wave 2: Unit B wires the real client and the invalidation, then Unit D.
