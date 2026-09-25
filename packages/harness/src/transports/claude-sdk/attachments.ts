import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { TurnInput } from "../../contract"
import { ClaudeTransportError } from "./errors"

type Block = Exclude<SDKUserMessage["message"]["content"], string>[number]
const images = ["image/gif", "image/jpeg", "image/png", "image/webp"] as const

async function writeAttachment(directory: string, file: { bytes: Buffer; filename?: string }): Promise<string> {
  const root = await fs.realpath(directory)
  const folder = path.join(root, ".claxedo", "attachments")
  const parent = path.join(root, ".claxedo")
  const parentStat = await fs.lstat(parent).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (parentStat?.isSymbolicLink()) throw new ClaudeTransportError("configuration", "Claude attachment directory escapes workspace")
  await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  if (!(await fs.realpath(folder)).startsWith(root + path.sep)) throw new ClaudeTransportError("configuration", "Claude attachment directory escapes workspace")
  try { await fs.writeFile(path.join(folder, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }) }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error }
  const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 12)
  const name = path.basename(file.filename ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)
  const target = path.join(folder, `${digest}-${name}`)
  try { await fs.writeFile(target, file.bytes, { mode: 0o600, flag: "wx" }) }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    const existing = await fs.lstat(target)
    if (!existing.isFile() || !(await fs.readFile(target)).equals(file.bytes)) throw new ClaudeTransportError("configuration", "Claude attachment target changed")
  }
  return target
}

export async function claudePrompt(turn: TurnInput, directory: string): Promise<SDKUserMessage> {
  const text = [turn.system, turn.prompt.system, ...turn.prompt.parts.filter((part) => part.type === "text").map((part) => part.text)]
    .filter(Boolean).join("\n\n")
  const blocks: Block[] = []
  const paths: string[] = []
  const files = turn.prompt.parts.filter((part) => part.type === "file").map((part) => {
    const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.url)
    if (!matched) throw new ClaudeTransportError("configuration", "Claude cannot deliver this file URL")
    const mime = part.mime || matched[1]!
    const bytes = Buffer.from(matched[2]!, "base64")
    if (bytes.length > 32 * 1024 * 1024) throw new ClaudeTransportError("configuration", "Claude attachment exceeds 32 MiB")
    return { mime, bytes, base64: matched[2]!, filename: part.filename }
  })
  for (const file of files) {
    const target = await writeAttachment(directory, file)
    paths.push(`Attached file (${file.mime}): ${target}`)
    const imageMime = images.find((mime) => mime === file.mime)
    if (imageMime) blocks.push({ type: "image", source: { type: "base64", media_type: imageMime, data: file.base64 } })
    if (file.mime === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } })
  }
  blocks.push({ type: "text", text: [text, ...paths].filter(Boolean).join("\n") })
  return { type: "user", session_id: "", message: { role: "user", content: blocks }, parent_tool_use_id: null }
}
