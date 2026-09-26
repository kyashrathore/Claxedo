import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { inside } from "@claxedo/helpers/path"
import type { TurnInput } from "../contract"
import { TransportError, type TransportErrorKind } from "../contract/errors"
import { inlineDataUrl } from "./prompt"

export type PromptAttachment = { mime: string; bytes: Buffer; base64: string; filename?: string }

export type MaterializedAttachment = PromptAttachment & { path: string }

export type AttachmentError = (message: string) => Error

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

const transportLabels: Partial<Record<TransportErrorKind, string>> = { claude: "Claude", cursor: "Cursor" }

export function attachmentErrorFor(transport: TransportErrorKind): AttachmentError {
  return (message) => new TransportError(transport, "configuration", `${transportLabels[transport] ?? transport} ${message}`)
}

export function turnAttachments(turn: TurnInput, error: AttachmentError): PromptAttachment[] {
  return turn.prompt.parts.filter((part) => part.type === "file").map((part) => {
    const data = inlineDataUrl(part.url, { imageOnly: false, strictBase64: true })
    if (!data) throw error("cannot deliver this file URL")
    const bytes = Buffer.from(data.data, "base64")
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw error("attachment exceeds 32 MiB")
    return { mime: part.mime || data.mimeType, bytes, base64: data.data, ...(part.filename ? { filename: part.filename } : {}) }
  })
}

async function attachmentFolder(directory: string, error: AttachmentError): Promise<string> {
  const root = await fs.realpath(directory)
  const folder = path.join(root, ".claxedo", "attachments")
  const parent = path.join(root, ".claxedo")
  const parentStat = await fs.lstat(parent).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
    throw cause
  })
  if (parentStat?.isSymbolicLink()) throw error("attachment directory escapes workspace")
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  if (!inside(root, await fs.realpath(folder))) throw error("attachment directory escapes workspace")
  try { await fs.writeFile(path.join(folder, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }) }
  catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause }
  return folder
}

export async function materializeAttachment(directory: string, file: PromptAttachment, error: AttachmentError): Promise<MaterializedAttachment> {
  const folder = await attachmentFolder(directory, error)
  const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 12)
  const name = path.basename(file.filename ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)
  const target = path.join(folder, `${digest}-${name}`)
  try { await fs.writeFile(target, file.bytes, { mode: 0o600, flag: "wx" }) }
  catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause
    const existing = await fs.lstat(target)
    if (!existing.isFile() || !(await fs.readFile(target)).equals(file.bytes)) throw error("attachment target changed")
  }
  return { ...file, path: target }
}

export function attachmentPathLine(attachment: MaterializedAttachment): string {
  return `Attached file (${attachment.mime}): ${attachment.path}`
}
