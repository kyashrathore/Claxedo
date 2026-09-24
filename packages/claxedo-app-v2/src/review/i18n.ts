import { dict as zh } from "./locales/zh"
import { dict as zht } from "./locales/zht"
import { dict as ko } from "./locales/ko"
import { dict as de } from "./locales/de"
import { dict as es } from "./locales/es"
import { dict as fr } from "./locales/fr"
import { dict as da } from "./locales/da"
import { dict as ja } from "./locales/ja"
import { dict as pl } from "./locales/pl"
import { dict as ru } from "./locales/ru"
import { dict as bs } from "./locales/bs"
import { dict as ar } from "./locales/ar"
import { dict as no } from "./locales/no"
import { dict as br } from "./locales/br"
import { dict as th } from "./locales/th"
import { dict as tr } from "./locales/tr"

export const en = {
  "review.tab": "Changes",
  "review.noPlacement": "Open a project to review its changes",
  "review.scope.label": "Compare",
  "review.scope.uncommitted": "Uncommitted changes",
  "review.scope.staged": "Staged changes",
  "review.scope.unstaged": "Unstaged changes",
  "review.scope.branch": "Branch changes",
  "review.scope.branchWorktree": "Everything since base",
  "review.scope.range": "Between two refs",
  "review.scope.base": "Base",
  "review.scope.from": "From",
  "review.scope.to": "To",
  "review.status.branch": "On {{branch}}",
  "review.status.ahead": "{{count}} ahead",
  "review.status.behind": "{{count}} behind",
  "review.status.noUpstream": "No upstream",
  "review.empty": "No changes",
  "review.showBranchDiff": "Show branch diff vs {{base}}",
  "review.loading": "Loading changes",
  "review.retry": "Retry",
  "review.openFile": "Open file",
  "review.expand": "Show diff",
  "review.collapse": "Hide diff",
  "review.change.added": "Added",
  "review.change.modified": "Modified",
  "review.change.deleted": "Deleted",
  "review.change.renamed": "Renamed",
  "review.change.untracked": "Untracked",
  "review.change.conflicted": "Conflicted",
  "review.diff.loading": "Loading diff",
  "review.diff.media": "No text diff for this file",
  "review.diff.empty": "No diff content",
  "review.largeDiff.title": "Diff too large to render",
  "review.largeDiff.meta": "Limit: {{limit}} changed lines. Current: {{current}} changed lines.",
  "review.largeDiff.renderAnyway": "Render anyway",
  "review.style.unified": "Unified",
  "review.style.split": "Split",
  "review.style.toggle": "Toggle diff style",
  "review.comment.placeholder": "Add comment",
  "review.comment.add": "Add comment",
  "review.comment.cancel": "Cancel",
  "review.comment.line": "line {{line}}",
  "review.comment.lines": "lines {{start}}-{{end}}",
  "review.comment.on": "Comment on {{target}}",
  "review.comment.pending": "Comments for the agent",
  "review.comment.remove": "Remove comment",
  "review.commit.message": "Message (⌘⏎ to commit)",
  "review.commit": "Commit",
  "review.commit.files": "Files to commit",
  "review.commit.staging": "Staging…",
  "review.commit.committing": "Committing…",
  "review.commit.done": "Committed {{hash}}",
  "review.commit.nothing": "Select at least one file",
  "review.push": "Push",
  "review.publish": "Publish Branch",
  "review.push.pushing": "Pushing…",
  "review.push.done": "Pushed to {{remote}}/{{branch}}",
  "review.upToDate": "Up to date",
  "review.error.git_empty_message": "Enter a commit message.",
  "review.error.git_nothing_staged": "Nothing is staged.",
  "review.error.git_conflict": "Resolve the merge in progress first.",
  "review.error.git_push_rejected": "Push rejected: {{message}}",
  "review.error.git_timeout": "Git timed out: {{message}}",
  "review.worktrees": "Worktrees",
  "review.worktrees.empty": "No worktrees yet",
  "review.worktrees.new": "New worktree",
  "review.worktrees.name": "Name",
  "review.worktrees.base": "Base ref",
  "review.worktrees.create": "Create worktree",
  "review.worktrees.creating": "Creating…",
  "review.worktrees.created": "Created {{label}}",
} as const

export type ReviewKey = keyof typeof en

export const reviewDictionaries: Readonly<Record<string, Readonly<Partial<Record<ReviewKey, string>>>>> = {
  en,
  zh,
  zht,
  ko,
  de,
  es,
  fr,
  da,
  ja,
  pl,
  ru,
  bs,
  ar,
  no,
  br,
  th,
  tr,
}

export function t(key: ReviewKey, params?: Readonly<Record<string, string | number>>): string {
  const template: string = en[key]
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
