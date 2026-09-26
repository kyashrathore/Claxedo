import type { Readable, Writable } from "node:stream"

export function processByteStreams(process: { stdin: Writable; stdout: Readable }): {
  input: ReadableStream<Uint8Array>
  output: WritableStream<Uint8Array>
} {
  const chunks: AsyncIterator<Buffer> = process.stdout[Symbol.asyncIterator]()
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(new Uint8Array(next.value))
    },
    async cancel() { await chunks.return?.() },
  })
  const output = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise<void>((resolve, reject) => { process.stdin.write(chunk, (error) => error ? reject(error) : resolve()) }),
    close: () => new Promise<void>((resolve) => { process.stdin.end(() => resolve()) }),
    abort: () => { process.stdin.destroy() },
  })
  return { input, output }
}
