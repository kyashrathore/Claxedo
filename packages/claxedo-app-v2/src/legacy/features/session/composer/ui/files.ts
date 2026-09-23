import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/lib/file-picker"
import { harnessDisplayLabel, harnessSelectionId, type HarnessType } from "@/features/session/harness/profile"

export { ACCEPTED_FILE_TYPES }

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
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

/**
 * The mime an attachment travels under: an image type the harness image inputs
 * accept, `application/pdf`, `text/plain` for anything that sniffs as text, and
 * otherwise the file's own declared type — `application/octet-stream` when it
 * declares none. Whether the destination can take that mime is
 * `attachmentRefusal`'s question, not this one.
 */
export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type

  const suffix = ext(file.name)
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  if (type && type !== "application/octet-stream") return type

  // Nothing declared a usable type, so the bytes decide whether the file is
  // text the agent can read or an opaque blob.
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (textBytes(bytes)) return "text/plain"
  return "application/octet-stream"
}

/**
 * Where the prompt this composer builds is going.
 *
 * `workspace` is whether the session's runtime can write an attachment into the
 * workspace it runs in, which is what lets an agent reach any file type at all
 * by path. A workspace reached through the relay has no such path, so there
 * only the harness's own prompt inputs remain.
 */
export type AttachmentTarget = {
  harness?: HarnessType
  workspace: boolean
}

export type AttachmentRefusal = {
  harness: string
  mime: string
}

const isImage = (mime: string) => IMAGE_MIMES.has(mime)

type HarnessPromptInputs = {
  /** Whether the harness's own prompt inputs carry this mime. */
  carries: (mime: string) => boolean
  /** Whether its driver writes an attachment into the workspace and names the path. */
  materializes: boolean
}

const HARNESS_PROMPT_INPUTS: Record<string, HarnessPromptInputs> = {
  claude: { carries: (mime) => isImage(mime) || mime === "application/pdf", materializes: true },
  codex: { carries: isImage, materializes: true },
  cursor: { carries: isImage, materializes: true },
  pi: { carries: isImage, materializes: false },
  // The engine takes the prompt contract's file parts as they are.
  opencode: { carries: () => true, materializes: false },
}

/**
 * What a harness with no entry above is assumed to offer. A connected agent
 * declares its own prompt capabilities to the runtime rather than here, so this
 * stays at the set the composer has always accepted.
 */
const CONNECTED_AGENT: HarnessPromptInputs = {
  carries: (mime) => isImage(mime) || mime === "application/pdf" || mime === "text/plain",
  materializes: false,
}

/**
 * Why the target cannot take this attachment, or `undefined` when it can.
 *
 * A target with no harness yet refuses nothing: the toast has to name the
 * harness that cannot take the file, and there is no evidence to name one with.
 */
export function attachmentRefusal(mime: string, target: AttachmentTarget): AttachmentRefusal | undefined {
  const harness = target.harness
  if (!harness) return undefined
  const native = harness.kind === "native" ? harness.harnessId : undefined
  const inputs = (native ? HARNESS_PROMPT_INPUTS[native] : undefined) ?? CONNECTED_AGENT
  if (inputs.carries(mime)) return undefined
  if (inputs.materializes && target.workspace) return undefined
  return { harness: harnessDisplayLabel(harnessSelectionId(harness)), mime }
}
