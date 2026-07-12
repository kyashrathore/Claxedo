// Guard for applying a harness-selector value change.
//
// The harness selector is a Kobalte `<Select>`. Like a native `<select>`, its
// trigger performs *typeahead* while closed: with the trigger focused, a bare
// alphanumeric keystroke (e.g. "c") mutates the selected value without ever
// opening the listbox. Switching harness is a heavy, side-effectful action
// (backend session migration), so silently changing it from stray typing —
// e.g. a keyboard user who tabbed onto the trigger and started typing a prompt —
// is a bug.
//
// We only apply a selection that happened while the menu was actually open
// (an explicit open → highlight → choose flow, mouse or keyboard). A value
// change that arrives while the menu is closed is a stray typeahead and is
// rejected. This preserves the intended power-user flow (open the menu, arrow,
// Enter) while blocking silent mutation.

export function shouldApplyHarnessSelection(input: {
  next: string | undefined
  current: string
  disabled: boolean
  openedViaMenu: boolean
}): boolean {
  if (!input.next) return false
  if (input.disabled) return false
  if (input.next === input.current) return false
  // Reject stray typeahead-while-closed: only apply an explicit menu selection.
  if (!input.openedViaMenu) return false
  return true
}
