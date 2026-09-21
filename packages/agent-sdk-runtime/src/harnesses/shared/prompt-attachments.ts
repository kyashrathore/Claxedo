import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { inside } from "@claxedo/helpers/path"
import { extractTextFromParts, record, text } from "./sdk-runtime-values"

export const PROMPT_IMAGE_MIMES = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const
export type PromptImageMime = typeof PROMPT_IMAGE_MIMES[number]

const IMAGE_MIMES: ReadonlySet<string> = new Set(PROMPT_IMAGE_MIMES)

export function isPromptImageMime(mime: string): mime is PromptImageMime {
  return IMAGE_MIMES.has(mime)
}

/** Bytes a prompt carries inline, with the `data:` url they arrived in. */
export type PromptAttachment = {
  mime: string
  base64: string
  url: string
  filename?: string
}

export type MaterializedAttachment = PromptAttachment & { path: string }

export type PromptDelivery = {
  /** The prompt's text, with a line naming each attachment's workspace path. */
  text: string
  attachments: MaterializedAttachment[]
}

const PROMPT_ATTACHMENT_SEGMENTS = [".claxedo", "attachments"] as const

/** Decoded bytes one attachment may write to the workspace. */
export const PROMPT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024

const MIME_EXTENSIONS = new Map([
  ["application/pdf", ".pdf"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["text/plain", ".txt"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
])

function parseDataUrl(url: string) {
  if (!url.startsWith("data:")) return undefined
  const comma = url.indexOf(",")
  if (comma === -1) return undefined
  const meta = url.slice("data:".length, comma).split(";").map((item) => item.trim().toLowerCase())
  const mime = meta[0]
  if (!mime || !meta.slice(1).includes("base64")) return undefined
  return { mime, base64: url.slice(comma + 1) }
}

/**
 * The attachments a prompt carries, in part order.
 *
 * Only a `file` part holding a base64 `data:` url is one. A part pointing at a
 * path or an http url is a reference the composer has already written into the
 * prompt text as an `@mention`, so naming it again would repeat it.
 */
export function promptAttachments(parts: readonly unknown[]): PromptAttachment[] {
  return parts.flatMap((part) => {
    const row = record(part)
    if (row?.type !== "file") return []
    const url = text(row.url)
    const bytes = url ? parseDataUrl(url) : undefined
    if (!url || !bytes) return []
    const filename = text(row.filename)
    return [{
      mime: text(row.mime) ?? bytes.mime,
      base64: bytes.base64,
      url,
      ...(filename ? { filename } : {}),
    }]
  })
}

function attachmentDiskName(attachment: PromptAttachment, digest: string) {
  const declared = path.basename(attachment.filename ?? "")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+/g, "")
    .slice(-80)
  return `${digest}-${declared || `attachment${MIME_EXTENSIONS.get(attachment.mime) ?? ".bin"}`}`
}

/**
 * Keeps the attachments a prompt leaves behind out of the user's `git status`.
 *
 * `wx` fails rather than truncates, so an ignore file already in the directory
 * — whatever it says — is the one that stays: its rule is the user's, and a
 * prompt is no reason to replace it.
 */
async function ignoreAttachmentDirectory(folder: string) {
  try {
    await fs.writeFile(path.join(folder, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 })
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err
  }
}

/**
 * Writes each attachment into the workspace and answers where.
 *
 * The name carries a digest of the bytes, so re-sending the same attachment
 * resolves to the same path instead of accumulating copies.
 */
export async function materializeAttachments(input: {
  directory: string
  attachments: readonly PromptAttachment[]
}): Promise<MaterializedAttachment[]> {
  if (!input.attachments.length) return []
  const decoded = input.attachments.map((attachment) => ({
    attachment,
    bytes: Buffer.from(attachment.base64, "base64"),
  }))
  // Every bound is checked before the workspace is touched, so a refusal
  // leaves no partial delivery behind.
  for (const { bytes } of decoded) {
    if (bytes.byteLength > PROMPT_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Prompt attachment exceeds the ${PROMPT_ATTACHMENT_MAX_BYTES}-byte limit`)
    }
  }
  const folder = path.join(path.resolve(input.directory), ...PROMPT_ATTACHMENT_SEGMENTS)
  const root = await fs.realpath(path.resolve(input.directory))
  // `.claxedo` resolves before anything is created through it, so a link out
  // of the workspace is refused with nothing written — not even the directory
  // `mkdir` would otherwise add at the link's target.
  const parent = await fs.realpath(path.dirname(folder)).catch(() => undefined)
  if (parent !== undefined && !inside(root, parent)) {
    throw new Error("Prompt attachment directory escapes the workspace")
  }
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  // The write side of the containment is the resolved path: deciding on the
  // name the prompt spells would follow a link the filesystem would not.
  const resolved = await fs.realpath(folder)
  if (!inside(root, resolved)) {
    throw new Error("Prompt attachment directory escapes the workspace")
  }
  await ignoreAttachmentDirectory(resolved)
  const written: MaterializedAttachment[] = []
  for (const { attachment, bytes } of decoded) {
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12)
    const name = attachmentDiskName(attachment, digest)
    const target = path.join(resolved, name)
    if (path.dirname(target) !== resolved) {
      throw new Error("Prompt attachment path escapes the workspace attachment directory")
    }
    await writePrivateFileAtomic(target, bytes)
    written.push({ ...attachment, path: path.join(folder, name) })
  }
  return written
}

export function attachmentPathLines(attachments: readonly MaterializedAttachment[]) {
  return attachments.map((attachment) => `Attached file (${attachment.mime}): ${attachment.path}`)
}

/**
 * The prompt a harness receives: its text, one line per attachment naming the
 * workspace path the attachment was written to, and the attachments themselves
 * for a harness that also has a native image input.
 *
 * The path is the delivery every harness understands, because every harness
 * can read a workspace file with its own tools; a native image input only adds
 * the picture to the model's context.
 */
export async function deliverPromptAttachments(input: {
  parts: readonly unknown[]
  directory: string
}): Promise<PromptDelivery> {
  const attachments = await materializeAttachments({
    directory: input.directory,
    attachments: promptAttachments(input.parts),
  })
  return {
    text: [extractTextFromParts([...input.parts]), ...attachmentPathLines(attachments)]
      .filter(Boolean)
      .join("\n"),
    attachments,
  }
}

/** The attachments a harness with a native image input should also send as images. */
export function promptImageAttachments(delivery: PromptDelivery) {
  return delivery.attachments.filter((attachment) => isPromptImageMime(attachment.mime))
}
