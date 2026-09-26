import { sameHarnessSelection, type HarnessSelection } from "@/lib/harness-selection"

export function shouldApplyHarnessSelection(input: {
  next: HarnessSelection | undefined
  current: HarnessSelection | undefined
  disabled: boolean
  openedViaMenu: boolean
}): boolean {
  if (!input.next) return false
  if (input.disabled) return false
  if (sameHarnessSelection(input.next, input.current)) return false
  if (!input.openedViaMenu) return false
  return true
}
