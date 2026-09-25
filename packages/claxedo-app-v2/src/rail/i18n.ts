import type { Translations } from "@/i18n"
import ar from "./locales/ar"
import br from "./locales/br"
import bs from "./locales/bs"
import da from "./locales/da"
import de from "./locales/de"
import es from "./locales/es"
import fr from "./locales/fr"
import ja from "./locales/ja"
import ko from "./locales/ko"
import no from "./locales/no"
import pl from "./locales/pl"
import ru from "./locales/ru"
import th from "./locales/th"
import tr from "./locales/tr"
import zh from "./locales/zh"
import zht from "./locales/zht"

const en = {
  "rail.tasks": "Tasks",
  "rail.openTasks": "Open Tasks",
  "rail.marketplace": "Marketplace",
  "rail.openMarketplace": "Open Marketplace",
  "rail.projects": "Projects",
  "rail.collapseProject": "Collapse project",
  "rail.expandProject": "Expand project",
  "rail.newSessionTooltip": "New session",
  "rail.newSessionIn": "New session in {{project}}",
  "rail.newTerminalTooltip": "New terminal…",
  "rail.newTerminalIn": "New terminal in {{project}}…",
  "rail.archiveSession": "Archive {{title}}",
  "rail.sessionMenu": "Options for {{title}}",
  "rail.noMatches": "No sessions match the current view.",
  "rail.loadMore": "Load more",
  "rail.loadingMore": "Loading...",
  "rail.loadingSessions": "Loading sessions...",
  "rail.loadFailed": "Could not load sessions.",
  "rail.loadMoreFailed": "Could not load more sessions.",
  "rail.allLoaded": "All sessions loaded.",
  "rail.retry": "Retry",
  "rail.settings": "Settings",
  "rail.account.signedIn": "Signed in",
  "rail.account.signingIn": "Signing in…",
  "rail.account.signIn": "Sign in",
  "rail.account.notSignedIn": "Not signed in",
  "rail.account.usage": "Usage",
  "rail.account.help": "Help",
  "rail.account.cancelSignIn": "Cancel sign in",
  "rail.account.logout": "Log out",
  "rail.account.signInFailed": "Sign-in failed",
  "rail.account.signOutFailed": "Sign-out failed",
  "rail.copySessionLink": "Copy session link",
  "rail.copyDeepLink": "Copy deep link",
  "rail.copyFailed": "The link could not be copied",
  "rail.rename": "Rename",
  "rail.renameLabel": "Session title",
  "rail.save": "Save",
  "rail.cancel": "Cancel",
  "rail.archive": "Archive",
  "rail.delete": "Delete",
  "rail.deleteTitle": "Delete session",
  "rail.deleteConfirm": 'Delete session "{{name}}"?',
  "rail.deleteButton": "Delete session",
  "rail.renameFailed": "The session could not be renamed",
  "rail.archiveFailed": "The session could not be archived",
  "rail.deleteFailed": "The session could not be deleted",
  "rail.workbenchPanes": "Workbench panes",
  "rail.marker.cloud": "Cloud environment",
  "rail.marker.machine": "Another machine",
  "rail.marker.worktree": "Worktree: {{project}} / {{name}}",
  "rail.terminal.close": "Close terminal",
  "rail.terminal.closeNamed": "Close terminal: {{title}}",
  "rail.terminal.working": "working",
  "rail.terminal.needsInput": "needs input",
  "rail.terminal.failed": "failed",
  "rail.terminal.done": "done",
  "rail.closeTab": "Close {{title}}",
  "rail.global": "Global",
  "rail.untitled": "Untitled session",
  "rail.card.status": "Status",
  "rail.card.working": "Working",
  "rail.card.waiting": "Waiting for you",
  "rail.card.failed": "Last turn failed",
  "rail.card.project": "Project",
  "rail.card.workspace": "Workspace",
} as const

export type RailKey = keyof typeof en

export const railDictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<RailKey>
