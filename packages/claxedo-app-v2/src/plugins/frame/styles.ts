export function appStylesheetText(): string {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href && new URL(sheet.href).origin !== location.origin) continue
    for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText)
  }
  return parts.join("\n")
}

export function appTheme(): { readonly id: string | undefined; readonly colorScheme: string | undefined } {
  const { theme, colorScheme } = document.documentElement.dataset
  return { id: theme, colorScheme }
}
