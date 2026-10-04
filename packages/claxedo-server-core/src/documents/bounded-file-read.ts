import type { Stats } from "node:fs"
import type { FileHandle } from "node:fs/promises"

export class BoundedFileTooLargeError extends Error {
  constructor(readonly actualBytes: number) {
    super(`File is ${actualBytes} bytes`)
    this.name = "BoundedFileTooLargeError"
  }
}

export async function readBoundedFile(
  handle: FileHandle,
  maxBytes: number,
): Promise<Readonly<{ content: Buffer; before: Stats; after: Stats }>> {
  const before = await handle.stat()
  if (before.size > maxBytes) throw new BoundedFileTooLargeError(before.size)
  const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, before.size + 1))
  const bytesRead = await readIntoBuffer(handle, buffer, 0)
  const after = await handle.stat()
  if (bytesRead > maxBytes || after.size > maxBytes) {
    throw new BoundedFileTooLargeError(Math.max(bytesRead, after.size))
  }
  return { content: buffer.subarray(0, bytesRead), before, after }
}

async function readIntoBuffer(handle: FileHandle, buffer: Buffer, offset: number): Promise<number> {
  if (offset === buffer.byteLength) return offset
  const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
  if (result.bytesRead === 0) return offset
  return await readIntoBuffer(handle, buffer, offset + result.bytesRead)
}
