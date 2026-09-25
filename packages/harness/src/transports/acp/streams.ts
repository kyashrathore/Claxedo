import type { Readable, Writable } from "node:stream"

export function webReadable(output: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Buffer> = output[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(new Uint8Array(next.value))
    },
    async cancel() { await chunks.return?.() },
  })
}

export function webWritable(input: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk) => new Promise<void>((resolve, reject) => { input.write(chunk, (error) => error ? reject(error) : resolve()) }),
    close: () => new Promise<void>((resolve) => { input.end(() => resolve()) }),
    abort: () => { input.destroy() },
  })
}
