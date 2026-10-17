export function codeFence(text: string, language: string | undefined): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = "`".repeat(longest + 1)
  return `${fence}${language ?? ""}\n${text}\n${fence}`
}

export function webUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
}
