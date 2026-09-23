export type ComposerCollapseInput = {
  collapsible: boolean
  editorFocused: boolean
  /** No text, images or comments in the draft. */
  blank: boolean
  contextItemCount: number
  popoverOpen: boolean
  documentPickerOpen: boolean
}

/**
 * A collapsible composer folds to one row only while it has nothing to show
 * above that row: an open popover, a context chip or a draft would otherwise
 * be laid out over a form that has no room for them.
 */
export function composerCollapsed(input: ComposerCollapseInput): boolean {
  if (!input.collapsible) return false
  if (input.editorFocused) return false
  if (!input.blank) return false
  if (input.contextItemCount > 0) return false
  if (input.popoverOpen || input.documentPickerOpen) return false
  return true
}
