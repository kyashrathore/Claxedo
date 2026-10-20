export function appSourceOrigin(): string {
  return location.protocol === "file:" ? "file:" : location.origin
}

function servedByApp(href: string): boolean {
  const url = new URL(href)
  return location.protocol === "file:" ? url.protocol === "file:" : url.origin === location.origin
}

export function appStylesheetText(): string {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href && !servedByApp(sheet.href)) continue
    for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText)
  }
  return parts.join("\n")
}

export function appTheme(): { readonly id: string | undefined; readonly colorScheme: string | undefined } {
  const { theme, colorScheme } = document.documentElement.dataset
  return { id: theme, colorScheme }
}
