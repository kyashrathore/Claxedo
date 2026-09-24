import { defaultTitleTemplates } from "./i18n"

const titlePatterns = defaultTitleTemplates.map((template) => {
  const [prefix = "", suffix = ""] = template.split("{{number}}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${prefix}(\\d+)${suffix}$`)
})

export function defaultTitleNumber(title: string): number | undefined {
  for (const pattern of titlePatterns) {
    const match = pattern.exec(title)
    if (!match) continue
    const number = Number(match[1])
    if (Number.isFinite(number) && number > 0) return number
  }
  return undefined
}

export function nextTerminalNumber(rows: readonly { readonly title: string }[]): number {
  const taken = new Set(rows.flatMap((row) => {
    const number = defaultTitleNumber(row.title)
    return number === undefined ? [] : [number]
  }))
  let next = 1
  while (taken.has(next)) next += 1
  return next
}
