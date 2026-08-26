// Pure classification of the session page's global keydown handler. The DOM
// concerns (composedPath walking, active-element resolution, dialog state,
// focusing the input) stay in `session.tsx`; the decision of what a key event
// *means* once those guards pass is here.

/** Tag names that count as an editable/interactive target we must not hijack. */
export function isEditableTagName(tagName: string): boolean {
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tagName)
}

export type SessionKeyAction =
  | "scroll-gesture" // explicit scroll keys → record a user-scroll gesture
  | "focus-input" // a printable character → focus the composer
  | "ignore"

/**
 * Decide how the session page should react to a keydown, assuming the event's
 * target is not an editable element and no dialog is open.
 *
 * - PageUp / PageDown / Home / End → treat as a scroll gesture.
 * - A single printable character with no ctrl/meta modifier → focus the
 *   composer so typing starts a message.
 * - Anything else (modified keys, multi-char keys, "Unidentified") → ignore.
 */
export function classifySessionKeydown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): SessionKeyAction {
  const { key } = event
  if (key === "PageUp" || key === "PageDown" || key === "Home" || key === "End") {
    return "scroll-gesture"
  }
  if (key.length === 1 && key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
    return "focus-input"
  }
  return "ignore"
}
