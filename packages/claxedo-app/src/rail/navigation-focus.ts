export function focusNavigationRow(root: HTMLElement, sessionId: string): boolean {
  const row = root.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`)
  const target = row?.querySelector<HTMLElement>('[data-slot="navigation-row-activate"]:not(:disabled)')
  if (!target) return false
  target.focus({ preventScroll: true })
  return true
}
