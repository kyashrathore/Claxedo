import type { Translations } from "@/i18n"
import { dict as ar } from "./locales/ar"
import { dict as br } from "./locales/br"
import { dict as bs } from "./locales/bs"
import { dict as da } from "./locales/da"
import { dict as de } from "./locales/de"
import { dict as es } from "./locales/es"
import { dict as fr } from "./locales/fr"
import { dict as ja } from "./locales/ja"
import { dict as ko } from "./locales/ko"
import { dict as no } from "./locales/no"
import { dict as pl } from "./locales/pl"
import { dict as ru } from "./locales/ru"
import { dict as th } from "./locales/th"
import { dict as tr } from "./locales/tr"
import { dict as zh } from "./locales/zh"
import { dict as zht } from "./locales/zht"

const en = {
  "review.mode.uncommitted": "Uncommitted",
  "review.mode.staged": "Staged",
  "review.mode.unstaged": "Unstaged",
  "review.mode.toFrom": "to / from",
  "review.mode.branch": "Branch changes",
  "review.mode.branchWorktree": "Everything since base",
  "review.scope.uncommitted": "Uncommitted changes",
  "review.scope.staged": "Staged changes",
  "review.scope.unstaged": "Unstaged changes",
  "review.scope.branch": "Branch changes",
  "review.scope.since": "Everything since {{ref}}",
  "review.label.uncommitted": "uncommitted changes",
  "review.label.staged": "staged changes",
  "review.label.unstaged": "unstaged changes",
  "review.label.range": "{{from}} -> {{to}}",
  "review.label.branch": "changes since {{ref}}",
  "review.label.branchWorktree": "everything since {{ref}}",
  "review.label.onBranch": "{{label}} on {{branch}}",
  "review.label.withUncommitted": "{{label}}, uncommitted included",
  "review.compare.header": "Compare against",
  "review.compare.against": "against {{ref}}",
  "review.compare.chooseBase": "Choose base",
  "review.compare.base": "Base",
  "review.compare.search": "Search branches, tags, commits",
  "review.compare.noMatches": "No matching refs",
  "review.compare.workingTree": "working tree",
  "review.compare.group.default": "Default branch",
  "review.compare.group.branches": "Branches",
  "review.compare.group.remote": "Remote branches",
  "review.compare.group.tags": "Tags",
  "review.compare.group.commits": "Commits",
  "review.expandAll": "Expand all",
  "review.collapseAll": "Collapse all",
  "review.style.unified": "Unified",
  "review.style.split": "Split",
  "review.loadingReview": "Loading review...",
  "review.emptyMode": "No changes for this review mode",
  "review.showBranchDiff": "Show branch diff vs",
  "review.directory": "dir: {{directory}}",
  "review.noDirectory": "no directory bound to this panel",
  "review.via": "via {{url}}",
  "review.change.added": "Added",
  "review.change.removed": "Removed",
  "review.change.modified": "Modified",
  "review.copy": "Copy",
  "review.openFile": "Open file",
  "review.diff.loading": "Loading diff…",
  "review.diff.retry": "Retry loading diff",
  "review.largeDiff.title": "Diff too large to render",
  "review.largeDiff.meta": "Limit: {{limit}} changed lines. Current: {{current}} changed lines.",
  "review.largeDiff.renderAnyway": "Render anyway",
  "review.comment.gutter": "Comment",
  "review.comment.more": "More options",
  "review.comment.edit": "Edit",
  "review.comment.delete": "Delete",
  "review.comment.save": "Save",
  "review.sourceControl.message": "Message (⌘⏎ to commit)",
  "review.sourceControl.commit": "Commit",
  "review.sourceControl.commitMenu": "More commit actions",
  "review.sourceControl.commitAndPush": "Commit & Push",
  "review.sourceControl.amend": "Amend last commit",
  "review.sourceControl.publish": "Publish Branch",
  "review.sourceControl.push": "Push",
  "review.sourceControl.upToDate": "Up to date",
  "review.sourceControl.group.staged": "Staged changes",
  "review.sourceControl.group.changes": "Changes",
  "review.sourceControl.group.graph": "Graph",
  "review.sourceControl.group.compare": "Compared changes",
  "review.sourceControl.stage": "Stage",
  "review.sourceControl.unstage": "Unstage",
  "review.sourceControl.stageAll": "Stage all",
  "review.sourceControl.unstageAll": "Unstage all",
  "review.sourceControl.empty": "No changes",
  "review.sourceControl.loading": "Loading changes",
  "review.sourceControl.graphEmpty": "No commits",
  "review.status.added": "Added",
  "review.status.modified": "Modified",
  "review.status.deleted": "Deleted",
  "review.status.renamed": "Renamed",
  "review.status.untracked": "Untracked",
  "review.status.conflicted": "Conflicted",
  "review.error.git_empty_message": "Enter a commit message.",
  "review.error.git_nothing_staged": "Nothing is staged.",
  "review.error.git_conflict": "Resolve the merge in progress first.",
  "review.error.git_push_rejected": "Push rejected: {{message}}",
  "review.error.git_timeout": "Git timed out: {{message}}",
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
