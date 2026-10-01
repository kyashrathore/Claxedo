import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { inside } from "@claxedo/helpers/path"

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

export async function writeContained(root: string, target: string, content: string, beforeOpen?: () => void | Promise<void>) {
  const parent = await fs.realpath(path.dirname(target))
  if (!inside(root, parent)) throw new Error("Runtime document path escapes workspace")
  const authority = await fs.stat(parent)
  await beforeOpen?.()
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  const opened = await handle.stat()
  const final = await fs.lstat(target)
  const real = await fs.realpath(target)
  const finalParent = await fs.realpath(path.dirname(target))
  const finalAuthority = await fs.stat(finalParent)
  if (
    !opened.isFile() ||
    !final.isFile() ||
    opened.dev !== final.dev ||
    opened.ino !== final.ino ||
    !inside(root, real)
  ) {
    await handle.close()
    throw new Error("Runtime document path changed while opening")
  }
  if (parent !== finalParent || authority.dev !== finalAuthority.dev || authority.ino !== finalAuthority.ino) {
    await handle.close()
    throw new Error("Runtime document parent changed while opening")
  }
  await handle.truncate(0)
  await handle.writeFile(content)
  await handle.sync()
  await handle.close()
}

export async function readContained(root: string, target: string, beforeOpen?: () => void | Promise<void>) {
  const real = await fs.realpath(target)
  if (!inside(root, real)) throw new Error("Runtime document path escapes workspace")
  const parent = await fs.realpath(path.dirname(target))
  const authority = await fs.stat(parent)
  const before = await fs.lstat(target)
  await beforeOpen?.()
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Runtime document path changed while opening")
    }
    if (opened.size > MAX_DOCUMENT_BYTES) throw new Error("Runtime document exceeds 2 MiB")
    const body = await readFileBounded(handle, MAX_DOCUMENT_BYTES, opened.size)
    const final = await handle.stat()
    const after = await fs.realpath(target).catch(() => undefined)
    const finalParent = await fs.realpath(path.dirname(target)).catch(() => undefined)
    const finalAuthority = finalParent ? await fs.stat(finalParent).catch(() => undefined) : undefined
    if (
      body.byteLength !== final.size ||
      opened.dev !== final.dev ||
      opened.ino !== final.ino ||
      opened.size !== final.size ||
      opened.mtimeMs !== final.mtimeMs ||
      !after ||
      !inside(root, after) ||
      finalParent !== parent ||
      finalAuthority?.dev !== authority.dev ||
      finalAuthority?.ino !== authority.ino
    ) {
      throw new Error("Runtime document changed while reading")
    }
    if (body.includes(0)) throw new Error("Runtime document is not valid UTF-8 text")
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
  } finally {
    await handle.close()
  }
}

async function readFileBounded(handle: fs.FileHandle, maxBytes: number, expectedBytes: number) {
  const body = Buffer.allocUnsafe(Math.min(maxBytes + 1, expectedBytes + 1))
  let offset = 0
  while (offset < body.byteLength) {
    const result = await handle.read(body, offset, body.byteLength - offset, offset)
    if (!result.bytesRead) break
    offset += result.bytesRead
  }
  if (offset > maxBytes) throw new Error("Runtime document exceeds 2 MiB")
  return body.subarray(0, offset)
}

export async function secureDirectory(root: string, start: string, segments: readonly string[]) {
  let current = start
  for (const segment of segments) {
    current = path.join(current, segment)
    await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    if (!inside(root, await fs.realpath(current))) throw new Error("Runtime document directory escapes workspace")
  }
  return current
}

