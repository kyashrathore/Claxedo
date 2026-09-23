export type MarkdownParseMode = "sync" | "async"

export async function parseMarkdownMeasured(input: {
  parse: () => string | Promise<string>
  clock: () => number | undefined
  trace: (mode: MarkdownParseMode, started: number | undefined) => void
}) {
  const started = input.clock()
  const parsed = input.parse()

  if (typeof parsed === "string") {
    input.trace("sync", started)
    return parsed
  }

  const result = await parsed
  input.trace("async", started)
  return result
}
