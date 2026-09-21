/**
 * `isTrusted` is set only by the browser on events it synthesises from real
 * input; script-created events, `dispatchEvent`, and `element.click()` all
 * carry `false` and the flag is read-only. Page script shares the guest DOM
 * with the preload, so this flag is the one signal that separates a user's
 * pick or Send from one a page forged.
 */

type TrustedFlag = Pick<Event, "isTrusted">

export const TRUSTED_INPUT_EVENT_TYPES = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown"] as const

/**
 * react-grab reports a selection from its own window `pointerup` listener
 * and awaits one animation frame before calling `onElementSelect`, which
 * carries no event. 1500 ms bounds that trusted-pointerup-to-hook gap on a
 * stalled frame while keeping a page's synthetic pick out once the user's
 * hand has been still.
 */
export const TRUSTED_INPUT_WINDOW_MS = 1500

export function isTrustedActivation(event: TrustedFlag): boolean {
  return event.isTrusted
}

export type TrustedInputGate = {
  noteTrustedEvent: (event: TrustedFlag) => void
  hasRecentTrustedInput: () => boolean
}

export function createTrustedInputGate(now: () => number, windowMs: number = TRUSTED_INPUT_WINDOW_MS): TrustedInputGate {
  let lastTrustedAt: number | null = null
  return {
    noteTrustedEvent(event) {
      if (event.isTrusted) lastTrustedAt = now()
    },
    hasRecentTrustedInput() {
      return lastTrustedAt !== null && now() - lastTrustedAt <= windowMs
    },
  }
}
