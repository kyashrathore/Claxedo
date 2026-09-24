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
}
