export type ComposerTextKey =
  | "composer.attachment.reading"
  | "composer.attachment.refused.title"
  | "composer.attachment.refused.description"
  | "composer.attachment.unreadable.title"
  | "composer.attachment.unreadable.description"
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
  | "prompt.popover.atLabel"
  | "prompt.popover.slashLabel"
  | "prompt.popover.emptyResults"
  | "prompt.popover.emptyCommands"
  | "prompt.popover.filesFailed"
  | "prompt.popover.commandsFailed"
  | "prompt.slash.badge.skill"
  | "prompt.slash.badge.mcp"
  | "prompt.slash.badge.custom"
  | "prompt.slash.badge.saved"
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
  | "composer.requestFailed"
  | "prompt.toast.goalStopFailed.title"
  | "prompt.imageMarks.title"
  | "prompt.imageMarks.hint"
  | "prompt.imageMarks.delete"
  | "prompt.imageMarks.mark"
  | "composer.cancel"
  | "common.save"
  | "composer.health.stopped"
  | "composer.health.checkAgain"
  | "composer.recovery.chooseModel"
  | "composer.recovery.noModels"

  | "model.provider.anthropic"
  | "model.provider.openai"
  | "model.provider.google"
  | "model.provider.xai"
  | "model.provider.meta"
  | "model.input.text"
  | "model.input.image"
  | "model.input.audio"
  | "model.input.video"
  | "model.input.pdf"
  | "model.tooltip.reasoning.allowed"
  | "model.tooltip.reasoning.none"
  | "model.tooltip.context"
  | "model.tooltip.allows"
  | "dialog.model.select.title"
  | "command.model.choose"
  | "command.model.choose.description"
  | "command.category.model"

export const composerEnglish: Record<ComposerTextKey, string> = {
  "composer.attachment.reading": "Reading {{filename}}…",
  "composer.attachment.refused.title": "{{harness}} cannot take this attachment",
  "composer.attachment.refused.description": "{{harness}} has no prompt input for {{mime}}, and this session has no workspace folder to keep the file in.",
  "composer.attachment.unreadable.title": "Attachment could not be read",
  "composer.attachment.unreadable.description": "{{filename}} could not be read from this device.",
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
  "prompt.popover.atLabel": "Mentions",
  "prompt.popover.slashLabel": "Commands",
  "prompt.popover.emptyResults": "No matching results",
  "prompt.popover.emptyCommands": "No matching commands",
  "prompt.popover.filesFailed": "Files could not be searched:",
  "prompt.popover.commandsFailed": "The harness's own commands could not be read:",
  "prompt.slash.badge.skill": "skill",
  "prompt.slash.badge.mcp": "mcp",
  "prompt.slash.badge.custom": "custom",
  "prompt.slash.badge.saved": "saved",
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
  "composer.requestFailed": "Request failed",
  "prompt.toast.goalStopFailed.title": "Could not stop Goal",
  "prompt.imageMarks.title": "Mark up image",
  "prompt.imageMarks.hint": "Drag to box an area or click to drop a pin, then comment on it.",
  "prompt.imageMarks.delete": "Delete mark",
  "prompt.imageMarks.mark": "mark {{number}}",
  "composer.cancel": "Cancel",
  "common.save": "Save",
  "composer.recovery.chooseModel": "Choose a model to resend",
  "composer.recovery.noModels": "No other models are available. Configure another model in Settings → Providers.",

  "model.provider.anthropic": "Anthropic",
  "model.provider.openai": "OpenAI",
  "model.provider.google": "Google",
  "model.provider.xai": "xAI",
  "model.provider.meta": "Meta",
  "model.input.text": "text",
  "model.input.image": "image",
  "model.input.audio": "audio",
  "model.input.video": "video",
  "model.input.pdf": "pdf",
  "model.tooltip.reasoning.allowed": "Allows reasoning",
  "model.tooltip.reasoning.none": "No reasoning",
  "model.tooltip.context": "Context limit {{limit}}",
  "model.tooltip.allows": "Allows: {{inputs}}",
  "composer.health.stopped": "The agent stopped responding",
  "composer.health.checkAgain": "Check again",
  "dialog.model.select.title": "Select model",
  "command.model.choose": "Choose model",
  "command.model.choose.description": "Select a different model",
  "command.category.model": "Model",
}
