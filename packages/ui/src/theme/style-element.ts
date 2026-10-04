/**
 * Find (or create) the `<style>` element a theme writes its CSS into. An
 * element with the id that is not a `<style>` is replaced rather than written
 * through, so a host page that happens to own the id cannot silently swallow
 * the theme.
 */
export function ensureThemeStyleElement(id: string): HTMLStyleElement {
  const existing = document.getElementById(id)
  if (existing instanceof HTMLStyleElement) return existing
  existing?.remove()
  const element = document.createElement("style")
  element.id = id
  document.head.appendChild(element)
  return element
}
