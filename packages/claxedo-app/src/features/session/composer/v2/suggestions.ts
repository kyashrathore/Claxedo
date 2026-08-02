// AtOption / SlashCommand  <->  PromptInputV2Suggestion.
//
// Upstream's controller speaks ONE flat `PromptInputV2Suggestion` shape for both
// the `@` and `/` surfaces; our frame renders the two Claxedo option shapes
// (`ui/slash-popover.tsx`). These pure mappings are the whole seam, and they are
// deliberately lossless in the direction that matters: the suggestion `id` IS
// `promptAtOptionKey(option)` / `command.id`, so the controller's `activeID` and
// our frame's `atActive`/`slashActive` are the same string with no lookup table.
import { promptAtOptionKey } from "@/features/session/composer/ui/prompt-options"
import type { AtOption, SlashCommand } from "@/features/session/composer/ui/slash-popover"
import type { ComposerDocumentOption } from "@/features/session/composer/document-picker-controller"
import type { PromptInputV2Suggestion } from "@/ui/session-kit"

const DOCUMENT_ID_PREFIX = "document:"

/**
 * `label` is load-bearing for commands: upstream's state machine writes
 * `` `${item.label} ` `` into the draft when a command row is selected
 * (`machine.ts#suggestionSelected`), so it must be the `/trigger` text our
 * legacy `handleSlashSelect` inserted, not the human title.
 */
export function slashCommandSuggestion(command: SlashCommand): PromptInputV2Suggestion {
  return {
    id: command.id,
    kind: "command",
    label: `/${command.trigger}`,
    title: command.title,
    trigger: command.trigger,
    description: command.description,
    keybind: command.keybind ? [command.keybind] : undefined,
  }
}

/**
 * `mention` is what the controller hands to `store.addMention`, so it carries
 * exactly the `ContentPart` our legacy `handleAtSelect` built — same `@path` /
 * `@name` content, therefore the same pill and the same `build-request-parts`
 * source offsets in the sent message.
 */
export function atOptionSuggestion(option: AtOption): PromptInputV2Suggestion {
  const id = promptAtOptionKey(option)
  if (option.type === "agent") {
    return {
      id,
      kind: "agent",
      label: option.display,
      mention: { type: "agent", name: option.name, content: `@${option.name}`, start: 0, end: 0 },
    }
  }
  if (option.type === "document") {
    return { id, kind: "resource", label: option.display }
  }
  return {
    id,
    kind: "file",
    label: option.display,
    path: option.path,
    recent: option.recent,
    mention: { type: "file", path: option.path, content: `@${option.path}`, start: 0, end: 0 },
  }
}

/** The documentId a `kind: "resource"` suggestion stands for, or undefined. */
export function suggestionDocumentId(suggestion: PromptInputV2Suggestion) {
  if (suggestion.kind !== "resource") return undefined
  if (!suggestion.id.startsWith(DOCUMENT_ID_PREFIX)) return undefined
  return suggestion.id.slice(DOCUMENT_ID_PREFIX.length)
}

/**
 * Back-projection for the frame. Search hits are minted inside the controller's
 * own async list, so this reconstructs from the suggestion itself rather than
 * looking anything up — except documents, whose status/placement badges only
 * exist on the picker's rows.
 */
export function suggestionAtOption(
  suggestion: PromptInputV2Suggestion,
  documents: readonly ComposerDocumentOption[],
): AtOption | undefined {
  if (suggestion.kind === "agent") return { type: "agent", name: suggestion.label, display: suggestion.label }
  if (suggestion.kind === "file") {
    if (!suggestion.path) return undefined
    return { type: "file", path: suggestion.path, display: suggestion.label, recent: suggestion.recent }
  }
  const documentId = suggestionDocumentId(suggestion)
  if (!documentId) return undefined
  const document = documents.find((entry) => entry.documentId === documentId)
  if (!document) return undefined
  return {
    type: "document",
    documentId: document.documentId,
    display: document.displayName,
    originKind: document.originKind,
    placementKind: document.placementKind,
    status: document.status,
  }
}

export function suggestionAtOptions(
  suggestions: readonly PromptInputV2Suggestion[],
  documents: readonly ComposerDocumentOption[],
): AtOption[] {
  return suggestions.flatMap((suggestion) => {
    const option = suggestionAtOption(suggestion, documents)
    return option ? [option] : []
  })
}

export function suggestionSlashCommands(
  suggestions: readonly PromptInputV2Suggestion[],
  source: readonly SlashCommand[],
): SlashCommand[] {
  return suggestions.flatMap((suggestion) => {
    const command = source.find((entry) => entry.id === suggestion.id)
    return command ? [command] : []
  })
}

/** The `ComposerDocumentSelection` `document-picker-controller#select` wants. */
export function documentSelection(document: ComposerDocumentOption) {
  return {
    type: "document" as const,
    documentId: document.documentId,
    display: document.displayName,
    originKind: document.originKind,
    placementKind: document.placementKind,
    status: document.status,
  }
}
