import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import { CursorTransportError } from "./errors"
import type { WorkerReply, WorkerRequest } from "./protocol"

export function cursorWorkerEnvironment(base: NodeJS.ProcessEnv, backendUrl?: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (backendUrl !== undefined) {
    env.CURSOR_BACKEND_URL = backendUrl
    delete env.CURSOR_API_KEY
  }
  return env
}

type Pending = { resolve(reply: WorkerReply): void; reject(error: unknown): void; onEvent?(reply: WorkerReply): void }

export class CursorWorker {
  private readonly worker: Worker
  private readonly port: MessagePort
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private failure?: CursorTransportError

  constructor(baseEnv: NodeJS.ProcessEnv, backendUrl?: string) {
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    const source = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)
    this.worker = new Worker(source, { workerData: { port: port2 }, transferList: [port2],
      env: cursorWorkerEnvironment(baseEnv, backendUrl) })
    port1.on("message", (reply: WorkerReply) => this.receive(reply))
    this.worker.on("error", (cause) => this.fail(new CursorTransportError("worker", "Cursor SDK worker crashed", cause)))
    this.worker.on("exit", (code) => this.fail(new CursorTransportError("worker", `Cursor SDK worker exited with code ${code}`)))
  }

  get failed() { return this.failure !== undefined }

  private receive(reply: WorkerReply) {
    const pending = this.pending.get(reply.id)
    if (!pending) return
    if (reply.kind === "event") { pending.onEvent?.(reply); return }
    this.pending.delete(reply.id)
    if (reply.kind === "error") pending.reject(new CursorTransportError("sdk", reply.message))
    else pending.resolve(reply)
  }

  private fail(error: CursorTransportError) {
    if (this.failure) return
    this.failure = error
    this.port.close()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  call(command: WorkerRequest, onEvent?: (reply: WorkerReply) => void): Promise<WorkerReply> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent })
      this.port.postMessage({ ...command, id })
    })
  }

  async retire(): Promise<void> {
    this.fail(new CursorTransportError("worker", "Cursor SDK worker retired"))
    this.port.close()
    await this.worker.terminate()
  }
}

export class CursorWorkerRegistry {
  private readonly workers = new Map<string, CursorWorker>()
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  acquire(binding: string, backendUrl?: string): CursorWorker {
    const current = this.workers.get(binding)
    if (current && !current.failed) return current
    const worker = new CursorWorker(this.env, backendUrl)
    this.workers.set(binding, worker)
    return worker
  }

  existing(binding: string): CursorWorker | undefined {
    const worker = this.workers.get(binding)
    return worker && !worker.failed ? worker : undefined
  }

  async replace(binding: string): Promise<void> {
    const current = this.workers.get(binding)
    if (!current) return
    this.workers.delete(binding)
    await current.retire()
  }

  async dispose(): Promise<void> {
    const workers = [...this.workers.values()]
    this.workers.clear()
    await Promise.all(workers.map((worker) => worker.retire()))
  }
}
