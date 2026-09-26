import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { inside } from "@claxedo/helpers/path"
import type { TurnInput } from "../contract"
import { inlineDataUrl } from "./prompt"

export type PromptFile = { mime: string; bytes: Buffer; base64: string; filename?: string }
export type MaterializedFile = PromptFile & { path: string }
export type AttachmentError = (message: string) => Error

export const PROMPT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024
export const promptImageMimes = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const
export type PromptImageMime = typeof promptImageMimes[number]

const extensions: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf", "audio/mpeg": ".mp3", "audio/wav": ".wav", "image/gif": ".gif", "image/jpeg": ".jpg",
  "image/png": ".png", "image/webp": ".webp", "text/plain": ".txt", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
}

export function isPromptImage(mime: string): mime is PromptImageMime {
  return (promptImageMimes as readonly string[]).includes(mime)
}

export function promptFiles(turn: TurnInput, error: AttachmentError): { files: PromptFile[]; references: string[] } {
  const files: PromptFile[] = []
  const references: string[] = []
  for (const part of turn.prompt.parts) {
    if (part.type !== "file") continue
    const data = inlineDataUrl(part.url, { imageOnly: false, strictBase64: true })
    if (!data) { references.push(part.url); continue }
    const bytes = Buffer.from(data.data, "base64")
    if (bytes.length > PROMPT_ATTACHMENT_MAX_BYTES) throw error(`Prompt attachment exceeds ${PROMPT_ATTACHMENT_MAX_BYTES} bytes`)
    files.push({ mime: part.mime || data.mimeType, bytes, base64: data.data, ...(part.filename ? { filename: part.filename } : {}) })
  }
  return { files, references }
}

function isCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code
}

async function attachmentFolder(directory: string, error: AttachmentError): Promise<{ resolved: string; named: string }> {
  const root = await fs.realpath(directory)
  const parent = await fs.lstat(path.join(root, ".claxedo")).catch((cause: unknown) => {
    if (isCode(cause, "ENOENT")) return undefined
    throw cause
  })
  if (parent?.isSymbolicLink()) throw error("Prompt attachment directory escapes the workspace")
  const folder = path.join(root, ".claxedo", "attachments")
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const resolved = await fs.realpath(folder)
  if (!inside(root, resolved)) throw error("Prompt attachment directory escapes the workspace")
  try { await fs.writeFile(path.join(resolved, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }) }
  catch (cause) { if (!isCode(cause, "EEXIST")) throw cause }
  return { resolved, named: path.join(path.resolve(directory), ".claxedo", "attachments") }
}

export async function materializeAttachment(directory: string, file: PromptFile, error: AttachmentError): Promise<MaterializedFile> {
  const folder = await attachmentFolder(directory, error)
  const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 12)
  const declared = path.basename(file.filename ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(-80)
  const name = `${digest}-${declared || `attachment${extensions[file.mime] ?? ".bin"}`}`
  const target = path.join(folder.resolved, name)
  try { await fs.writeFile(target, file.bytes, { mode: 0o600, flag: "wx" }) }
  catch (cause) {
    if (!isCode(cause, "EEXIST")) throw cause
    const existing = await fs.lstat(target)
    if (!existing.isFile() || !(await fs.readFile(target)).equals(file.bytes)) throw error("Prompt attachment target changed")
  }
  return { ...file, path: path.join(folder.named, name) }
}

export function attachmentPathLine(file: MaterializedFile): string {
  return `Attached file (${file.mime}): ${file.path}`
}
