type Cleanable = string | undefined | null

export type ArenaSignal = "continue" | "done" | "question"

export type OpencodePart = {
  type?: string
  text?: string
  ignored?: boolean
  toolName?: string
  state?: { status?: string; output?: unknown } | null
  title?: string
}

export type OpencodeError = {
  name?: string
  message?: string
  data?: { message?: string; providerID?: string; modelID?: string }
}

export type OpencodePromptResult = {
  info?: { id?: string; providerID?: string; modelID?: string; error?: OpencodeError | null }
  parts?: OpencodePart[]
}

export type PageArenaPromptAgent = {
  display_name: string
  role: string
  duty: string
  style: string
}

function clean(value: Cleanable) {
  if (typeof value !== "string") return ""
  return value.trim()
}

export function modelRef(value: string) {
  const source = clean(value)
  if (!source) return undefined
  const idx = source.indexOf("/")
  if (idx < 1 || idx >= source.length - 1) return undefined
  return {
    providerID: source.slice(0, idx),
    modelID: source.slice(idx + 1),
  }
}

export function apiPath(pathname: string, directory: string) {
  if (!directory) return pathname
  const join = pathname.includes("?") ? "&" : "?"
  return `${pathname}${join}directory=${encodeURIComponent(directory)}`
}

export function parseFooter(text: string) {
  const source = text.trimEnd()
  const match = /(?:\r?\n)?@arena:(continue|done|question)\s*$/i.exec(source)
  if (!match) {
    return {
      visible: source,
      signal: "continue" as ArenaSignal,
      parse_warning: true,
    }
  }
  const signal = (match[1] ?? "continue").toLowerCase() as ArenaSignal
  const visible = source.slice(0, match.index).trimEnd()
  return {
    visible: visible || source,
    signal,
    parse_warning: false,
  }
}

export function extractText(parts: OpencodePart[] | undefined) {
  const text = (parts || [])
    .filter((part) => part.type === "text" && !part.ignored)
    .map((part) => part.text || "")
    .join("")
    .trim()
  if (text) return text
  const toolText = (parts || [])
    .filter((part) => part.type === "tool" && part.state?.status === "completed")
    .map((part) => {
      const output = part.state?.output
      if (typeof output === "string") return output
      if (!output || typeof output !== "object") return ""
      const value = (output as { text?: unknown }).text
      return typeof value === "string" ? value : ""
    })
    .join("\n")
    .trim()
  return toolText
}

export function extractError(result: OpencodePromptResult | null | undefined) {
  const error = result?.info?.error
  if (!error) return ""
  const message = clean(error.data?.message || error.message)
  if (!message) return "OpenCode model request failed"
  const provider = clean(error.data?.providerID)
  if (!provider) return message
  return `${provider}: ${message}`
}

export function compactRelay(text: string, max: number) {
  if (text.length <= max) return text
  const first = text
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .trim()
  if (first && first.length <= max) return `${first} …`
  return `${text.slice(0, Math.max(80, max - 2)).trimEnd()}…`
}

export function compactDocument(text: string, max: number) {
  const source = clean(text)
  if (!source) return ""
  if (source.length <= max) return source
  const keep = Math.max(200, Math.floor((max - 20) / 2))
  const head = source.slice(0, keep).trimEnd()
  const tail = source.slice(-keep).trimStart()
  return `${head}\n\n...[document truncated]...\n\n${tail}`
}

export function extractTools(parts: OpencodePart[] | undefined) {
  return (parts || [])
    .filter((part) => part.type === "tool" || part.type === "tool-invocation")
    .map((part) => {
      const output = part.state?.output
      const preview = typeof output === "string" ? output : JSON.stringify(output || "")
      return {
        name: clean(part.toolName || part.title || "tool"),
        status: clean(part.state?.status || "completed") || "completed",
        output: clean(preview).slice(0, 260),
      }
    })
    .filter((tool) => !!tool.name)
}

export function promptForAgent(input: {
  agent: PageArenaPromptAgent
  synopsis: string
  packets: string[]
  document: string
  round: number
}) {
  const style = clean(input.agent.style)
  const directives = [
    `You are ${input.agent.display_name}.`,
    `Role: ${input.agent.role}.`,
    `Duty: ${input.agent.duty}.`,
    "Speak naturally and stay tightly relevant to the user goal.",
    "If document context is provided below, treat it as the document under discussion unless the user overrides it.",
    "Keep your visible response under ~180 words when possible.",
    "At the end of your final line, append exactly one control tag: @arena:continue OR @arena:done OR @arena:question.",
    "Do not include any extra control syntax.",
  ]
  if (style) directives.push(`Style: ${style}.`)
  const intro = directives.join("\n")
  const synopsis = clean(input.synopsis)
  const packet = input.packets.length > 0 ? input.packets.join("\n\n") : "(no new peer input)"
  const body = [
    `Round: ${input.round}`,
    input.document ? `Document context (current page markdown):\n${input.document}` : "",
    synopsis ? `Arena synopsis:\n${synopsis}` : "",
    `Incoming discussion packets:\n${packet}`,
    "Respond now.",
  ]
    .filter(Boolean)
    .join("\n\n")
  return { system: intro, prompt: body }
}
