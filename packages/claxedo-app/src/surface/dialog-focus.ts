export const DIALOG_FIRST_FIELD = 'input:not([type="hidden"]):not([type="file"]), textarea, [contenteditable="true"]'

export type Focusable = { readonly isConnected: boolean; readonly focus: (options?: FocusOptions) => void }

export type FocusReturn = {
  readonly remember: (active: unknown) => void
  readonly restore: () => boolean
}

function isFocusable(value: unknown): value is Focusable {
  return typeof value === "object" && value !== null && "focus" in value && typeof value.focus === "function" && "isConnected" in value
}

export function createFocusReturn(): FocusReturn {
  let previous: Focusable | undefined
  return {
    remember: (active) => {
      previous = isFocusable(active) ? active : undefined
    },
    restore: () => {
      const target = previous
      previous = undefined
      if (!target?.isConnected) return false
      target.focus({ preventScroll: true })
      return true
    },
  }
}

export function ownsEscape(target: unknown): boolean {
  return typeof target === "object" && target !== null && "closest" in target && typeof target.closest === "function" && target.closest("[data-owns-escape]") !== null
}
