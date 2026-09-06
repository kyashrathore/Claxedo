// The title the runtime gives a terminal that the user has not renamed, in every
// locale the app ships. Terminal numbering reads it back out of the title, so the
// templates and the parser have to stay next to each other.
const templates = [
  "Terminal {{number}}",
  "محطة طرفية {{number}}",
  "Терминал {{number}}",
  "ターミナル {{number}}",
  "터미널 {{number}}",
  "เทอร์มินัล {{number}}",
  "终端 {{number}}",
  "終端機 {{number}}",
]

const patterns = templates.map((template) => {
  const [prefix = "", suffix = ""] = template.split("{{number}}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(`^${prefix}(\\d+)${suffix}$`)
})

/**
 * The number in a default terminal title ("Terminal 3" → 3), in any shipped
 * locale. `undefined` when the user has renamed the terminal.
 */
export function defaultTitleNumber(title: string): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(title)
    if (!match) continue
    const number = Number(match[1])
    if (Number.isFinite(number) && number > 0) return number
  }
  return undefined
}
