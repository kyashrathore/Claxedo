export type ComposerTextKey =
  | "composer.placeholder.normal"
  | "composer.placeholder.shell"
  | "composer.placeholder.goal"
  | "composer.editor.label"
  | "composer.popover.mentions"
  | "composer.popover.commands"
  | "composer.popover.noResults"
  | "composer.popover.noCommands"
  | "composer.dropzone.files"
  | "composer.dropzone.mention"
  | "composer.slash.badge.custom"
  | "composer.slash.badge.skill"
  | "composer.slash.badge.mcp"
  | "composer.context.removeFile"
  | "composer.action.add"
  | "composer.action.attach"
  | "composer.action.commands"
  | "composer.action.context"
  | "composer.action.shell"
  | "composer.action.goal"
  | "composer.action.clearGoal"
  | "composer.action.send"
  | "composer.action.stop"
  | "composer.action.retry"
  | "composer.action.dismiss"
  | "composer.action.cancel"
  | "composer.action.save"
  | "composer.attachment.remove"
  | "composer.attachment.reading"
  | "composer.attachment.refused.title"
  | "composer.attachment.refused.description"
  | "composer.attachment.unreadable.title"
  | "composer.attachment.unreadable.description"
  | "composer.marks.title"
  | "composer.marks.hint"
  | "composer.marks.open"
  | "composer.marks.delete"
  | "composer.marks.mark"
  | "composer.marks.remove"
  | "composer.key.esc"
  | "composer.error.title"
  | "composer.error.rate_limit"
  | "composer.error.auth"
  | "composer.error.network"
  | "composer.error.not_found"
  | "composer.error.conflict"
  | "composer.error.invalid"
  | "composer.error.internal"
  | "dialog.model.search.placeholder"
  | "dialog.model.empty"
  | "command.provider.connect"
  | "model.tag.free"
  | "model.tag.latest"
  | "prompt.action.stop"
  | "common.key.esc"
  | "prompt.action.send"
  | "prompt.dropzone.file.label"
  | "prompt.dropzone.label"
  | "prompt.attachment.remove"
  | "prompt.imageMarks.open"
  | "prompt.imageMarks.remove"
  | "prompt.action.add"
  | "prompt.action.imagesAndFiles"
  | "prompt.action.commands"
  | "prompt.action.context"
  | "prompt.action.shellCommand"
  | "prompt.action.goal"
  | "prompt.action.clearGoal"
  | "prompt.action.planMode"
  | "prompt.action.agentGroup"
  | "prompt.action.approveForMe"
  | "prompt.action.readOnlyWorkspace"
  | "prompt.popover.atLabel"
  | "prompt.popover.slashLabel"
  | "prompt.popover.emptyResults"
  | "prompt.popover.emptyCommands"
  | "prompt.slash.badge.skill"
  | "prompt.slash.badge.mcp"
  | "prompt.slash.badge.custom"
  | "prompt.context.removeFile"
  | "prompt.placeholder.shell"
  | "prompt.placeholder.normal"
  | "prompt.placeholder.simple"
  | "prompt.placeholder.summarizeComments"
  | "prompt.placeholder.summarizeComment"
  | "prompt.goal.placeholder"
  | "prompt.example.1"
  | "prompt.example.2"
  | "prompt.example.3"
  | "prompt.example.4"
  | "prompt.example.5"
  | "prompt.example.6"
  | "prompt.example.7"
  | "prompt.example.8"
  | "prompt.example.9"
  | "prompt.example.10"
  | "prompt.example.11"
  | "prompt.example.12"
  | "prompt.example.13"
  | "prompt.example.14"
  | "prompt.example.15"
  | "prompt.example.16"
  | "prompt.example.17"
  | "prompt.example.18"
  | "prompt.example.19"
  | "prompt.example.20"
  | "prompt.example.21"
  | "prompt.example.22"
  | "prompt.example.23"
  | "prompt.example.24"
  | "prompt.example.25"
  | "prompt.action.attachFile"
  | "command.category.file"
  | "command.prompt.mode.shell"
  | "command.prompt.mode.normal"
  | "command.category.session"
  | "prompt.toast.promptSendFailed.title"
  | "common.requestFailed"

export const composerEnglish: Record<ComposerTextKey, string> = {
  "composer.placeholder.normal": "Ask anything...",
  "composer.placeholder.shell": "Enter shell command…",
  "composer.placeholder.goal": "Describe the outcome this Goal should reach",
  "composer.editor.label": "Prompt",
  "composer.popover.mentions": "Mentions",
  "composer.popover.commands": "Commands",
  "composer.popover.noResults": "No matching results",
  "composer.popover.noCommands": "No matching commands",
  "composer.dropzone.files": "Drop images, PDFs, or text files here",
  "composer.dropzone.mention": "Drop to @mention file",
  "composer.slash.badge.custom": "custom",
  "composer.slash.badge.skill": "skill",
  "composer.slash.badge.mcp": "mcp",
  "composer.context.removeFile": "Remove file from context",
  "composer.action.add": "Add",
  "composer.action.attach": "Images and files",
  "composer.action.commands": "Commands",
  "composer.action.context": "Context",
  "composer.action.shell": "Shell command",
  "composer.action.goal": "Goal",
  "composer.action.clearGoal": "Clear goal",
  "composer.action.send": "Send",
  "composer.action.stop": "Stop",
  "composer.action.retry": "Retry",
  "composer.action.dismiss": "Dismiss",
  "composer.action.cancel": "Cancel",
  "composer.action.save": "Save",
  "composer.attachment.remove": "Remove attachment",
  "composer.attachment.reading": "Reading {{filename}}…",
  "composer.attachment.refused.title": "{{harness}} cannot take this attachment",
  "composer.attachment.refused.description": "{{harness}} has no prompt input for {{mime}}, and this session has no workspace folder to keep the file in.",
  "composer.attachment.unreadable.title": "Attachment could not be read",
  "composer.attachment.unreadable.description": "{{filename}} could not be read from this device.",
  "composer.marks.title": "Mark up image",
  "composer.marks.hint": "Drag to box an area or click to drop a pin, then comment on it.",
  "composer.marks.open": "Mark up image",
  "composer.marks.delete": "Delete mark",
  "composer.marks.mark": "mark {{number}}",
  "composer.marks.remove": "Remove mark",
  "composer.key.esc": "ESC",
  "composer.error.title": "Failed to send prompt",
  "composer.error.rate_limit": "The model is rate limited. Wait a moment, then retry.",
  "composer.error.auth": "Sign in to this provider again to continue.",
  "composer.error.network": "The server could not be reached. Check the connection and retry.",
  "composer.error.not_found": "This session no longer exists.",
  "composer.error.conflict": "Someone else changed this session first. Reload it and retry.",
  "composer.error.invalid": "The request was rejected as invalid.",
  "composer.error.internal": "Something went wrong on the server.",
  "dialog.model.search.placeholder": "Search models",
  "dialog.model.empty": "No model results",
  "command.provider.connect": "Connect provider",
  "model.tag.free": "Free",
  "model.tag.latest": "Latest",
  "prompt.action.stop": "Stop",
  "common.key.esc": "ESC",
  "prompt.action.send": "Send",
  "prompt.dropzone.file.label": "Drop to @mention file",
  "prompt.dropzone.label": "Drop images, PDFs, or text files here",
  "prompt.attachment.remove": "Remove attachment",
  "prompt.imageMarks.open": "Mark up image",
  "prompt.imageMarks.remove": "Remove mark",
  "prompt.action.add": "Add",
  "prompt.action.imagesAndFiles": "Images and files",
  "prompt.action.commands": "Commands",
  "prompt.action.context": "Context",
  "prompt.action.shellCommand": "Shell command",
  "prompt.action.goal": "Goal",
  "prompt.action.clearGoal": "Clear goal",
  "prompt.action.planMode": "Plan mode",
  "prompt.action.agentGroup": "Agent",
  "prompt.action.approveForMe": "Approve for me",
  "prompt.action.readOnlyWorkspace": "Read-only workspace",
  "prompt.popover.atLabel": "Mentions",
  "prompt.popover.slashLabel": "Commands",
  "prompt.popover.emptyResults": "No matching results",
  "prompt.popover.emptyCommands": "No matching commands",
  "prompt.slash.badge.skill": "skill",
  "prompt.slash.badge.mcp": "mcp",
  "prompt.slash.badge.custom": "custom",
  "prompt.context.removeFile": "Remove file from context",
  "prompt.placeholder.shell": "Enter shell command... {{example}}",
  "prompt.placeholder.normal": "Ask anything... \"{{example}}\"",
  "prompt.placeholder.simple": "Ask anything...",
  "prompt.placeholder.summarizeComments": "Summarize comments…",
  "prompt.placeholder.summarizeComment": "Summarize comment…",
  "prompt.goal.placeholder": "Describe the outcome this Goal should reach",
  "prompt.example.1": "Fix a TODO in the codebase",
  "prompt.example.2": "What is the tech stack of this project?",
  "prompt.example.3": "Fix broken tests",
  "prompt.example.4": "Explain how authentication works",
  "prompt.example.5": "Find and fix security vulnerabilities",
  "prompt.example.6": "Add unit tests for the user service",
  "prompt.example.7": "Refactor this function to be more readable",
  "prompt.example.8": "What does this error mean?",
  "prompt.example.9": "Help me debug this issue",
  "prompt.example.10": "Generate API documentation",
  "prompt.example.11": "Optimize database queries",
  "prompt.example.12": "Add input validation",
  "prompt.example.13": "Create a new component for...",
  "prompt.example.14": "How do I deploy this project?",
  "prompt.example.15": "Review my code for best practices",
  "prompt.example.16": "Add error handling to this function",
  "prompt.example.17": "Explain this regex pattern",
  "prompt.example.18": "Convert this to TypeScript",
  "prompt.example.19": "Add logging throughout the codebase",
  "prompt.example.20": "What dependencies are outdated?",
  "prompt.example.21": "Help me write a migration script",
  "prompt.example.22": "Implement caching for this endpoint",
  "prompt.example.23": "Add pagination to this list",
  "prompt.example.24": "Create a CLI command for...",
  "prompt.example.25": "How do environment variables work here?",
  "prompt.action.attachFile": "Add files",
  "command.category.file": "File",
  "command.prompt.mode.shell": "Shell",
  "command.prompt.mode.normal": "Prompt",
  "command.category.session": "Session",
  "prompt.toast.promptSendFailed.title": "Failed to send prompt",
  "common.requestFailed": "Request failed",
}
