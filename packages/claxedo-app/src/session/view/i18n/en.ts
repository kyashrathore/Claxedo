import type { TimelineTextKey } from "../timeline"

export type SessionScreenTextKey =
  | `sessionScreen.interrupted.${"title" | "description" | "resume" | "prompt"}`
  | `sessionScreen.timeline.${TimelineTextKey}`
  | "sessionScreen.loading"
  | "sessionScreen.untitled"
  | "sessionScreen.subagent.label"
  | "sessionScreen.subagent.task"
  | "sessionScreen.draft.title"
  | "sessionScreen.action.retry"
  | "sessionScreen.failed"
  | "sessionScreen.requests.loadFailed"
  | "sessionScreen.action.dismiss"
  | "sessionScreen.action.back"
  | "sessionScreen.action.next"
  | "sessionScreen.action.submit"
  | "sessionScreen.action.stop"
  | "sessionScreen.action.cancel"
  | "sessionScreen.action.loading"
  | "sessionScreen.question.progress"
  | "sessionScreen.question.expand"
  | "sessionScreen.question.collapse"
  | "sessionScreen.question.ownAnswer"
  | "sessionScreen.question.customPlaceholder"
  | "sessionScreen.question.singleHint"
  | "sessionScreen.question.multiHint"
  | "sessionScreen.question.questions"
  | "sessionScreen.permission.title"
  | "sessionScreen.permission.deny"
  | "sessionScreen.permission.allowAlways"
  | "sessionScreen.permission.allowOnce"
  | "sessionScreen.permission.workingDirectory"
  | "sessionScreen.permission.details"
  | "sessionScreen.permission.tool.read"
  | "sessionScreen.permission.tool.edit"
  | "sessionScreen.permission.tool.glob"
  | "sessionScreen.permission.tool.grep"
  | "sessionScreen.permission.tool.list"
  | "sessionScreen.permission.tool.bash"
  | "sessionScreen.permission.tool.task"
  | "sessionScreen.permission.tool.skill"
  | "sessionScreen.permission.tool.lsp"
  | "sessionScreen.permission.tool.todowrite"
  | "sessionScreen.permission.tool.webfetch"
  | "sessionScreen.permission.tool.websearch"
  | "sessionScreen.permission.tool.external_directory"
  | "sessionScreen.permission.tool.doom_loop"
  | "sessionScreen.todo.progress"
  | "sessionScreen.todo.collapse"
  | "sessionScreen.todo.expand"
  | "sessionScreen.connection.reconnecting"
  | "sessionScreen.goal.title"
  | "sessionScreen.goal.status.active"
  | "sessionScreen.goal.status.paused"
  | "sessionScreen.goal.status.blocked"
  | "sessionScreen.goal.status.limited"
  | "sessionScreen.goal.status.complete"
  | "sessionScreen.goal.pause"
  | "sessionScreen.goal.resume"
  | "sessionScreen.goal.delete"
  | "sessionScreen.goal.deleteTitle"
  | "sessionScreen.goal.deleteConfirm"
  | "sessionScreen.goal.metric.iteration"
  | "sessionScreen.goal.metric.tokensUsed"
  | "sessionScreen.goal.metric.tokenBudget"
  | "sessionScreen.goal.metric.timeUsed"
  | "sessionScreen.workspace.asleep"
  | "sessionScreen.workspace.machineOffline"
  | "sessionScreen.workspace.waking"
  | "sessionScreen.workspace.restoring"
  | "sessionScreen.workspace.resuming"
  | "sessionScreen.workspace.wakeFailed"
  | "sessionScreen.workspace.retryWake"
  | "sessionScreen.child.promptDisabled"
  | "sessionScreen.child.backToParent"
  | "command.message.previous"
  | "command.message.previous.description"
  | "command.message.next"
  | "command.message.next.description"

export const sessionScreenEnglish: Record<SessionScreenTextKey, string> = {
  "sessionScreen.interrupted.title": "Session interrupted",
  "sessionScreen.interrupted.description": "The previous run stopped. Resume it or send a message to continue.",
  "sessionScreen.interrupted.resume": "Resume",
  "sessionScreen.interrupted.prompt": "Continue the interrupted work. Check what completed before the interruption before repeating any actions.",
  "sessionScreen.loading": "Loading messages...",
  "sessionScreen.untitled": "Session",
  "sessionScreen.subagent.label": "Subagent",
  "sessionScreen.subagent.task": "Delegated task",
  "sessionScreen.draft.title": "New Session",
  "sessionScreen.action.retry": "Retry",
  "sessionScreen.failed": "Could not load this session.",
  "sessionScreen.requests.loadFailed": "Could not load pending permissions or questions. Retry to continue.",
  "sessionScreen.action.dismiss": "Dismiss",
  "sessionScreen.action.back": "Back",
  "sessionScreen.action.next": "Next",
  "sessionScreen.action.submit": "Submit",
  "sessionScreen.action.stop": "Stop",
  "sessionScreen.action.cancel": "Cancel",
  "sessionScreen.action.loading": "Loading",
  "sessionScreen.question.progress": "{{current}} of {{total}} questions",
  "sessionScreen.question.expand": "Expand question",
  "sessionScreen.question.collapse": "Collapse question",
  "sessionScreen.question.ownAnswer": "Type your own answer",
  "sessionScreen.question.customPlaceholder": "Type your answer...",
  "sessionScreen.question.singleHint": "Select one answer",
  "sessionScreen.question.multiHint": "Select all answers that apply",
  "sessionScreen.question.questions": "Questions",
  "sessionScreen.permission.title": "Permission required",
  "sessionScreen.permission.deny": "Deny",
  "sessionScreen.permission.allowAlways": "Allow always",
  "sessionScreen.permission.allowOnce": "Allow once",
  "sessionScreen.permission.workingDirectory": "Working directory",
  "sessionScreen.permission.details": "Details",
  "sessionScreen.permission.tool.read": "Reading a file (matches the file path)",
  "sessionScreen.permission.tool.edit": "Modify files, including edits, writes, and patches",
  "sessionScreen.permission.tool.glob": "Match files using glob patterns",
  "sessionScreen.permission.tool.grep": "Search file contents using regular expressions",
  "sessionScreen.permission.tool.list": "List files within a directory",
  "sessionScreen.permission.tool.bash": "Run shell commands",
  "sessionScreen.permission.tool.task": "Launch sub-agents",
  "sessionScreen.permission.tool.skill": "Load a skill by name",
  "sessionScreen.permission.tool.lsp": "Run language server queries",
  "sessionScreen.permission.tool.todowrite": "Update the todo list",
  "sessionScreen.permission.tool.webfetch": "Fetch content from a URL",
  "sessionScreen.permission.tool.websearch": "Search the web",
  "sessionScreen.permission.tool.external_directory": "Access files outside the project directory",
  "sessionScreen.permission.tool.doom_loop": "Detect repeated tool calls with identical input",
  "sessionScreen.todo.progress": "{{done}} of {{total}} todos completed",
  "sessionScreen.todo.collapse": "Collapse",
  "sessionScreen.todo.expand": "Expand",
  "sessionScreen.connection.reconnecting": "Reconnecting…",
  "sessionScreen.goal.title": "Goal",
  "sessionScreen.goal.status.active": "Active",
  "sessionScreen.goal.status.paused": "Paused",
  "sessionScreen.goal.status.blocked": "Blocked",
  "sessionScreen.goal.status.limited": "Limited",
  "sessionScreen.goal.status.complete": "Complete",
  "sessionScreen.goal.pause": "Pause",
  "sessionScreen.goal.resume": "Resume",
  "sessionScreen.goal.delete": "Delete",
  "sessionScreen.goal.deleteTitle": "Delete Goal?",
  "sessionScreen.goal.deleteConfirm": "This stops active Goal work before clearing the Goal.",
  "sessionScreen.goal.metric.iteration": "Iteration {{count}}",
  "sessionScreen.goal.metric.tokensUsed": "{{count}} tokens",
  "sessionScreen.goal.metric.tokenBudget": "{{count}} token budget",
  "sessionScreen.goal.metric.timeUsed": "{{seconds}}s",
  "sessionScreen.workspace.asleep": "This workspace is asleep. Your next message wakes it.",
  "sessionScreen.workspace.machineOffline": "This session's machine is offline. Its messages show again when the machine is back.",
  "sessionScreen.workspace.waking": "Waking up the workspace…",
  "sessionScreen.workspace.restoring": "Restoring it from a snapshot",
  "sessionScreen.workspace.resuming": "Resuming its sandbox",
  "sessionScreen.workspace.wakeFailed": "Couldn't wake the workspace.",
  "sessionScreen.workspace.retryWake": "Try again",
  "sessionScreen.child.promptDisabled": "Subagent sessions cannot be prompted.",
  "sessionScreen.child.backToParent": "Back to main session.",
  "sessionScreen.timeline.command.session.new": "New session",
  "sessionScreen.timeline.common.archive": "Archive",
  "sessionScreen.timeline.common.cancel": "Cancel",
  "sessionScreen.timeline.common.delete": "Delete",
  "sessionScreen.timeline.common.moreOptions": "More options",
  "sessionScreen.timeline.common.rename": "Rename",
  "sessionScreen.timeline.common.requestFailed": "Request failed",
  "sessionScreen.timeline.session.delete.button": "Delete session",
  "sessionScreen.timeline.session.delete.confirm": "Delete session \"{{name}}\"?",
  "sessionScreen.timeline.session.delete.failed.title": "Failed to delete session",
  "sessionScreen.timeline.session.delete.title": "Delete session",
  "sessionScreen.timeline.session.timeline.backgroundWork.agents.one": "{{count}} background agent running",
  "sessionScreen.timeline.session.timeline.backgroundWork.agents.other": "{{count}} background agents running",
  "sessionScreen.timeline.session.timeline.backgroundWork.shells.one": "{{count}} shell",
  "sessionScreen.timeline.session.timeline.backgroundWork.shells.other": "{{count}} shells",
  "sessionScreen.timeline.session.timeline.backgroundWork.tasks.one": "{{count}} other task",
  "sessionScreen.timeline.session.timeline.backgroundWork.tasks.other": "{{count}} other tasks",
  "sessionScreen.timeline.session.timeline.backgroundWork.shellsRunning.one": "{{count}} background shell running",
  "sessionScreen.timeline.session.timeline.backgroundWork.shellsRunning.other": "{{count}} background shells running",
  "sessionScreen.timeline.session.timeline.backgroundWork.tasksRunning.one": "{{count}} background task running",
  "sessionScreen.timeline.session.timeline.backgroundWork.tasksRunning.other": "{{count}} background tasks running",
  "sessionScreen.timeline.session.timeline.backgroundWork.hint": "Ask Claude about this work, or ask it to stop one.",
  "sessionScreen.timeline.session.timeline.collapseTranscript": "Collapse transcript",
  "sessionScreen.timeline.session.timeline.previousMessages.one": "{{count}} previous message",
  "sessionScreen.timeline.session.timeline.previousMessages.other": "{{count}} previous messages",
  "sessionScreen.timeline.session.timeline.scrollToBottom": "Scroll to latest message",
  "sessionScreen.timeline.session.timeline.quote.conversation": "Conversation",
  "sessionScreen.timeline.session.timeline.quote.plan": "Plan",
  "sessionScreen.timeline.ui.common.file.one": "file",
  "sessionScreen.timeline.ui.common.file.other": "files",
  "sessionScreen.timeline.ui.message.attachment.alt": "attachment",
  "sessionScreen.timeline.ui.message.interrupted": "Interrupted",
  "sessionScreen.timeline.ui.message.interruptedDuration": "You stopped after {{duration}}",
  "sessionScreen.timeline.ui.message.queued": "Queued",
  "sessionScreen.timeline.ui.message.queued.accepted": "Accepted · transcript position unconfirmed",
  "sessionScreen.timeline.ui.message.queued.cancelEdit": "Cancel edit",
  "sessionScreen.timeline.ui.message.queued.declined": "Not taken in · sends next",
  "sessionScreen.timeline.ui.message.queued.dispatching": "Awaiting harness acceptance",
  "sessionScreen.timeline.ui.message.queued.edit": "Edit",
  "sessionScreen.timeline.ui.message.queued.editing": "Editing",
  "sessionScreen.timeline.ui.message.queued.loadFailed": "Could not load queued messages.",
  "sessionScreen.timeline.ui.message.queued.remove": "Remove",
  "sessionScreen.timeline.ui.message.queued.retry": "Retry",
  "sessionScreen.timeline.ui.message.queued.sendNow": "Send now",
  "sessionScreen.timeline.ui.message.queued.unknown": "Delivery unknown · awaiting reconciliation",
  "sessionScreen.timeline.ui.message.revertMessage": "Revert message",
  "sessionScreen.timeline.ui.messagePart.compaction": "Session compacted",
  "sessionScreen.timeline.ui.sessionTurn.diffs.more": "+{{count}} more files",
  "sessionScreen.timeline.ui.sessionTurn.diffs.showAll": "Show all",
  "sessionScreen.timeline.ui.sessionTurn.diffs.showLess": "Show less",
  "sessionScreen.timeline.ui.sessionTurn.diffs.changed": "changed",
  "sessionScreen.timeline.ui.sessionTurn.status.thinking": "Thinking",
  "sessionScreen.timeline.turnRecovery.credential.title": "Reconnect your AI provider",
  "sessionScreen.timeline.turnRecovery.credential.description": "The provider rejected the credential for this workspace.",
  "sessionScreen.timeline.turnRecovery.credential.action": "Reconnect and resend",
  "sessionScreen.timeline.turnRecovery.harness.title": "The agent isn't responding",
  "sessionScreen.timeline.turnRecovery.harness.description": "The agent process stopped or couldn't run this turn.",
  "sessionScreen.timeline.turnRecovery.harness.action": "Resend last prompt",
  "sessionScreen.timeline.turnRecovery.model.title": "Try another model",
  "sessionScreen.timeline.turnRecovery.model.description": "The selected model couldn't serve this turn.",
  "sessionScreen.timeline.turnRecovery.model.action": "Switch model and resend",
  "sessionScreen.timeline.turnRecovery.rate_limit.title": "Rate limited",
  "sessionScreen.timeline.turnRecovery.rate_limit.description": "Try again shortly.",
  "sessionScreen.timeline.turnRecovery.rate_limit.action": "Resend",
  "sessionScreen.timeline.turnRecovery.usage_limit.title": "Usage limit reached",
  "sessionScreen.timeline.turnRecovery.usage_limit.description": "Choose another model or account.",
  "sessionScreen.timeline.turnRecovery.workspace.title": "Workspace isn't ready",
  "sessionScreen.timeline.turnRecovery.workspace.description": "The project workspace wasn't available for this turn.",
  "sessionScreen.timeline.turnRecovery.workspace.action": "Resend last prompt",
  "sessionScreen.timeline.turnRecovery.session.title": "This session was lost",
  "sessionScreen.timeline.turnRecovery.session.description": "The agent process no longer has this conversation. Its history is still here.",
  "sessionScreen.timeline.turnRecovery.session.action": "Start a new session",
  "sessionScreen.timeline.turnRecovery.unknown.title": "That turn didn't complete",
  "sessionScreen.timeline.turnRecovery.unknown.description": "The agent returned an error before completing this turn. Resend the last prompt.",
  "sessionScreen.timeline.turnRecovery.unknown.action": "Resend last prompt",
  "sessionScreen.timeline.turnRecovery.account.stored": "Account: {{label}} ({{harness}})",
  "sessionScreen.timeline.turnRecovery.account.machine": "Account: this computer's login ({{harness}})",
  "command.message.previous": "Previous message",
  "command.message.previous.description": "Go to the previous user message",
  "command.message.next": "Next message",
  "command.message.next.description": "Go to the next user message",
}
