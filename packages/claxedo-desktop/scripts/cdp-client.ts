import { readField, readFiniteNumber, readRecord, readString } from "@claxedo/helpers/readers"

export type CdpClient = {
  /**
   * Answers `unknown`. `Runtime.evaluate` returns whatever the page produced
   * and CDP promises nothing about its shape, so each caller below reads what
   * it needs — through the diagnostics contract's own schema where one exists
   * — instead of naming a `T` that nothing checks.
   */
  evaluate(expression: string): Promise<unknown>
  close(): void
}

export async function createCdpClient(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url)
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("Timed out connecting to packaged renderer CDP"))
    }, 15_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolveOpen()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("Could not connect to packaged renderer CDP"))
    }, { once: true })
  })
  const rejectPending = (error: Error) => {
    pending.forEach((request) => {
      clearTimeout(request.timer)
      request.reject(error)
    })
    pending.clear()
  }
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data))
    const id = readFiniteNumber(message, "id")
    if (id === undefined) return
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    clearTimeout(request.timer)
    const error = readRecord(message, "error")
    if (error) {
      request.reject(new Error(readString(error, "message") ?? "CDP command failed"))
      return
    }
    request.resolve(readField(message, "result"))
  })
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolveCommand, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Packaged renderer CDP command timed out: ${method}`))
      }, 15_000)
      pending.set(id, { resolve: resolveCommand, reject, timer })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  socket.addEventListener("close", () => rejectPending(new Error("Packaged renderer CDP closed")))
  socket.addEventListener("error", () => rejectPending(new Error("Packaged renderer CDP failed")))
  await command("Runtime.enable")
  return {
    // Answers `unknown`: `Runtime.evaluate` returns whatever the page produced
    // and CDP promises nothing about it, so callers narrow at their own site
    // instead of naming a `T` here that nothing checks.
    async evaluate(expression: string): Promise<unknown> {
      const output = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      const exceptionDetails = readRecord(output, "exceptionDetails")
      if (exceptionDetails) {
        throw new Error(
          readString(readRecord(exceptionDetails, "exception"), "description") ??
          readString(exceptionDetails, "text") ??
          "Packaged renderer evaluation failed",
        )
      }
      return readField(readField(output, "result"), "value")
    },
    close() {
      rejectPending(new Error("Packaged renderer CDP closed"))
      socket.close()
    },
  }
}
