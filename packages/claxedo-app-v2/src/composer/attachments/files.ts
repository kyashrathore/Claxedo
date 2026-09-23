export const acceptedImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export const acceptedFileTypes = [
  ...acceptedImageTypes,
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "audio/*",
  "video/*",
  "application/octet-stream",
  ".c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx",
  ".log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh",
]

const IMAGE_MIMES = new Set(acceptedImageTypes)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type

  const suffix = ext(file.name)
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  if (type && type !== "application/octet-stream") return type

  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (textBytes(bytes)) return "text/plain"
  return "application/octet-stream"
}

export type AttachmentTarget = {
  harness?: { id: string; name: string }
  workspace: boolean
}

export type AttachmentRefusal = {
  harness: string
  mime: string
}

const isImage = (mime: string) => IMAGE_MIMES.has(mime)

type HarnessPromptInputs = {
  carries: (mime: string) => boolean
  materializes: boolean
}

const HARNESS_PROMPT_INPUTS: Record<string, HarnessPromptInputs> = {
  claude: { carries: (mime) => isImage(mime) || mime === "application/pdf", materializes: true },
  codex: { carries: isImage, materializes: true },
  cursor: { carries: isImage, materializes: true },
  pi: { carries: isImage, materializes: false },
  opencode: { carries: () => true, materializes: false },
}

const CONNECTED_AGENT: HarnessPromptInputs = {
  carries: (mime) => isImage(mime) || mime === "application/pdf" || mime === "text/plain",
  materializes: false,
}

export function attachmentRefusal(mime: string, target: AttachmentTarget): AttachmentRefusal | undefined {
  const harness = target.harness
  if (!harness) return undefined
  const inputs = HARNESS_PROMPT_INPUTS[harness.id] ?? CONNECTED_AGENT
  if (inputs.carries(mime)) return undefined
  if (inputs.materializes && target.workspace) return undefined
  return { harness: harness.name, mime }
}
