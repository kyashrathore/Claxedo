import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import { TransportError } from "../../contract/errors"
import { stringRecord } from "@claxedo/helpers"
import type { WorkerReply, WorkerRequest } from "./protocol"
import { PendingRpcRequests } from "../../rpc/pending"

export function cursorWorkerEnvironment(base: NodeJS.ProcessEnv, backendUrl?: string): Record<string, string> {
  const env = stringRecord(base)
  if (backendUrl !== undefined) {
    env.CURSOR_BACKEND_URL = backendUrl
    delete env.CURSOR_API_KEY
  }
  return env
}

export class CursorWorker {
  private readonly worker: Worker
  private readonly port: MessagePort
  private readonly pending = new PendingRpcRequests<number, ((reply: WorkerReply) => void) | undefined, WorkerReply>()
  private nextId = 0
  private failure?: TransportError

  constructor(baseEnv: NodeJS.ProcessEnv, backendUrl?: string) {
    const { port1, port2 } = new MessageChannel()
    this.port = port1
    const source = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url)
    this.worker = new Worker(source, { workerData: { port: port2 }, transferList: [port2],
      env: cursorWorkerEnvironment(baseEnv, backendUrl) })
    port1.on("message", (reply: WorkerReply) => this.receive(reply))
    this.worker.on("error", (cause) => this.fail(new TransportError("cursor", "worker", "Cursor SDK worker crashed", { cause })))
    this.worker.on("exit", (code) => this.fail(new TransportError("cursor", "worker", `Cursor SDK worker exited with code ${code}`)))
  }

  get failed() { return this.failure !== undefined }

  private receive(reply: WorkerReply) {
    const onEvent = this.pending.get(reply.id)
    if (reply.kind === "event") { onEvent?.(reply); return }
    if (reply.kind === "error") this.pending.reject(reply.id, new TransportError("cursor", "sdk", reply.message))
    else this.pending.resolve(reply.id, reply)
  }

  private fail(error: TransportError) {
    if (this.failure) return
    this.failure = error
    this.port.close()
    this.pending.fail(error)
  }

  call(command: WorkerRequest, onEvent?: (reply: WorkerReply) => void): Promise<WorkerReply> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    return this.pending.request(id, onEvent, undefined, () => new TransportError("cursor", "worker", "Cursor worker did not answer"),
      () => this.port.postMessage({ ...command, id }))
  }

  async retire(): Promise<void> {
    this.fail(new TransportError("cursor", "worker", "Cursor SDK worker retired"))
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
