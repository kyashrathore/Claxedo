import type { Translations } from "@/i18n"

type SurfaceKey =
  | "surface.source.agent"
  | "surface.source.plugin"
  | "surface.callout.dismiss"
  | "surface.board.movable"
  | "surface.board.grabbed"
  | "surface.board.moved"
  | "surface.board.dropped"
  | "surface.board.cancelled"
  | "surface.file.chooseOne"
  | "surface.file.chooseMany"
  | "surface.file.drop"
  | "surface.file.dropOrPaste"
  | "surface.file.reading"
  | "surface.combobox.empty"
  | "surface.combobox.searching"
  | "surface.combobox.remove"
  | "surface.reference.unavailable"
  | "surface.dialog.close"
  | "surface.editor.loading"
  | "surface.editor.sourceTitle"
  | "surface.editor.sourceReason"
  | "surface.editor.sourceFailed"
  | "surface.editor.tryRich"
  | "surface.editor.stillSource"
  | "surface.editor.noMatches"
  | "surface.editor.commands"
  | "surface.editor.command.text"
  | "surface.editor.command.heading1"
  | "surface.editor.command.heading2"
  | "surface.editor.command.heading3"
  | "surface.editor.command.bulletList"
  | "surface.editor.command.numberedList"
  | "surface.editor.command.todoList"
  | "surface.editor.command.quote"
  | "surface.editor.command.codeBlock"
  | "surface.editor.command.divider"

export const surfaceDictionary = {
  en: {
    "surface.source.agent": "{{name}} · agent reply",
    "surface.source.plugin": "{{name}} · app plugin",
    "surface.callout.dismiss": "Dismiss",
    "surface.reference.unavailable": "This control is drawn only on an app plugin's page.",
    "surface.board.movable": "movable item",
    "surface.board.grabbed": "Picked up. Arrow keys move it, Space or Enter drops it, Escape cancels.",
    "surface.board.moved": "Moved to {{column}}, position {{position}}",
    "surface.board.dropped": "Dropped in {{column}}, position {{position}}",
    "surface.board.cancelled": "Move cancelled",
    "surface.file.chooseOne": "Choose a file",
    "surface.file.chooseMany": "Choose files",
    "surface.file.drop": "or drop here",
    "surface.file.dropOrPaste": "or drop or paste here",
    "surface.file.reading": "Reading…",
    "surface.combobox.empty": "No matches",
    "surface.combobox.searching": "Searching…",
    "surface.combobox.remove": "Remove {{label}}",
    "surface.dialog.close": "Close",
    "surface.editor.loading": "Loading the editor…",
    "surface.editor.sourceTitle": "Source mode",
    "surface.editor.sourceReason": "This text uses Markdown the rich editor cannot keep exactly as written, so it is shown as source.",
    "surface.editor.sourceFailed": "The rich editor did not load, so this text is shown as source.",
    "surface.editor.tryRich": "Try rich mode",
    "surface.editor.stillSource": "Checked again — still source mode.",
    "surface.editor.noMatches": "No matching blocks",
    "surface.editor.commands": "Insert a block",
    "surface.editor.command.text": "Text",
    "surface.editor.command.heading1": "Heading 1",
    "surface.editor.command.heading2": "Heading 2",
    "surface.editor.command.heading3": "Heading 3",
    "surface.editor.command.bulletList": "Bulleted list",
    "surface.editor.command.numberedList": "Numbered list",
    "surface.editor.command.todoList": "To-do list",
    "surface.editor.command.quote": "Quote",
    "surface.editor.command.codeBlock": "Code block",
    "surface.editor.command.divider": "Divider",
  },
} satisfies Translations<SurfaceKey>
