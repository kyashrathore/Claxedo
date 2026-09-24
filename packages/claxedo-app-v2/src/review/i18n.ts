import type { Translations } from "@/i18n"
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

const en = {
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
  "review.loadFailed": "The changes could not be loaded",
  "review.diff.failed": "This diff could not be loaded",
  "review.style.label": "Diff style",
  "review.change.added": "Added",
  "review.change.deleted": "Deleted",
  "review.diff.loading": "Loading diff",
  "review.diff.media": "No text diff for this file",
  "review.largeDiff.title": "Diff too large to render",
  "review.largeDiff.meta": "Limit: {{limit}} changed lines. Current: {{current}} changed lines.",
  "review.largeDiff.renderAnyway": "Render anyway",
  "review.style.unified": "Unified",
  "review.style.split": "Split",
  "review.style.toggle": "Toggle diff style",
  "review.comment.remove": "Remove comment",
  "review.comment.gutter": "Comment on this line",
  "review.comment.save": "Save",
  "review.comment.edit": "Edit",
  "review.comment.more": "Comment options",
  "review.comment.needSession": "Open a session to comment on lines for its agent",
  "review.commit.message": "Message (⌘⏎ to commit)",
  "review.commit.messageLabel": "Commit message",
  "review.commit": "Commit",
  "review.commit.files": "Files to commit",
  "review.commit.staging": "Staging…",
  "review.commit.committing": "Committing…",
  "review.commit.done": "Committed {{hash}}",
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
  "review.worktrees.create": "Create worktree",
  "review.worktrees.creating": "Creating…",
  "review.worktrees.created": "Created {{label}}",
}

export type ReviewKey = keyof typeof en

export const dictionary = {
  en,
  ar,
  br,
  bs,
  da,
  de,
  es,
  fr,
  ja,
  ko,
  no,
  pl,
  ru,
  th,
  tr,
  zh,
  zht,
} satisfies Translations<ReviewKey>
