import { readField, readFiniteNumber, readRecord, readString } from "@claxedo/helpers/readers"

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export type CdpPage = {
  evaluate<A = undefined>(fn: (arg: A) => unknown, arg?: A): Promise<unknown>
  evaluateExpression(expression: string): Promise<unknown>
  command(method: string, params?: Record<string, unknown>): Promise<unknown>
  waitFor<A>(fn: (arg: A) => unknown, arg: A, timeoutMs: number, label: string): Promise<void>
  close(): void
}

const RENDERER_DOCUMENT = /\/out\/renderer\/index[^/]*\.html/u

async function rendererTarget(port: number, alive: () => boolean, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (!alive()) throw new Error("Claxedo exited before its renderer accepted CDP")
    const targets: unknown = await fetch(`http://127.0.0.1:${String(port)}/json/list`, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.json(), () => [])
    if (!Array.isArray(targets)) throw new Error(`Claxedo's CDP target list is not a list: ${JSON.stringify(targets)}`)
    const target = targets.find((candidate) => readString(candidate, "type") === "page" && RENDERER_DOCUMENT.test(readString(candidate, "url") ?? ""))
    const socketUrl = readString(target, "webSocketDebuggerUrl")
    if (socketUrl) return socketUrl
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for Claxedo's renderer CDP target")
}

function openSocket(url: string, timeoutMs: number) {
  const socket = new WebSocket(url)
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to Claxedo's renderer CDP")), timeoutMs)
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket) }, { once: true })
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Claxedo's renderer CDP socket failed")) }, { once: true })
  })
}

function commandChannel(socket: WebSocket, timeoutMs: number) {
  const pending = new Map<number, Pending>()
  let sequence = 0
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data))
    const id = readFiniteNumber(message, "id")
    const request = id === undefined ? undefined : pending.get(id)
    if (!request || id === undefined) return
    pending.delete(id)
    clearTimeout(request.timer)
    const error = readField(message, "error")
    if (error) request.reject(new Error(readString(error, "message") ?? "CDP command failed"))
    else request.resolve(readField(message, "result"))
  })
  socket.addEventListener("close", () => fail(new Error("Claxedo's renderer CDP closed")))
  return (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP command timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

export async function connectCdpPage(input: { port: number; alive: () => boolean; timeoutMs: number }): Promise<CdpPage> {
  const socket = await openSocket(await rendererTarget(input.port, input.alive, input.timeoutMs), input.timeoutMs)
  const command = commandChannel(socket, input.timeoutMs)
  const evaluateExpression = async (expression: string) => {
    const output = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    const exceptionDetails = readField(output, "exceptionDetails")
    if (exceptionDetails) {
      throw new Error(readString(readRecord(exceptionDetails, "exception"), "description") ?? readString(exceptionDetails, "text") ?? "Renderer evaluation failed")
    }
    return readField(readField(output, "result"), "value")
  }
  const evaluate = <A>(fn: (arg: A) => unknown, arg?: A) =>
    evaluateExpression(`(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`)
  await command("Runtime.enable")
  return {
    evaluate,
    evaluateExpression,
    command,
    async waitFor(fn, arg, timeoutMs, label) {
      const deadline = performance.now() + timeoutMs
      while (performance.now() < deadline) {
        if (await evaluate(fn, arg)) return
        await Bun.sleep(16)
      }
      throw new Error(`Timed out waiting for Claxedo to show ${label}`)
    },
    close: () => socket.close(),
  }
}
