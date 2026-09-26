import { fileURLToPath } from "node:url"
import { HoldableCountdown, errorMessage, settleAtRequestDeadline, singleFlightUntil, stringRecord } from "@claxedo/helpers"
import type { Clock, Deadline, HarnessServices, Logger, OwnedProcess } from "../../contract"
import { TransportError } from "../../contract/errors"
import { NdjsonOwnedProcess } from "../../rpc/channel"
import { PendingRpcRequests } from "../../rpc/pending"
import { isHostReply, type HostReply, type HostRequest } from "./protocol"

export type CursorHostKey = { binding: string; home: string; backendUrl?: string }

const HOST_SCRIPT = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./host.ts" : "./host.js", import.meta.url))
const RUN_IDLE_MS = 600_000
const COMMAND_MS = 30_000

export function cursorHostEnvironment(base: NodeJS.ProcessEnv, home: string, backendUrl?: string): Record<string, string> {
  const env = stringRecord(base)
  env.HOME = home
  env.USERPROFILE = home
  delete env.CURSOR_DATA_DIR
  if (backendUrl !== undefined) {
    env.CURSOR_BACKEND_URL = backendUrl
    delete env.CURSOR_API_KEY
  }
  return env
}

export function cursorHostId(key: CursorHostKey): string {
  return `${key.binding}\n${key.home}`
}

function retirementDeadline(clock: Clock): Deadline {
  return { at: clock.now() + 5_000, signal: new AbortController().signal }
}

export class CursorHost {
  private readonly channel: NdjsonOwnedProcess
  private readonly pending = new PendingRpcRequests<number, ((reply: HostReply) => void) | undefined, HostReply>()
  private nextId = 0
  private failure?: TransportError
  private stderrBytes = 0

  constructor(readonly process: OwnedProcess, private readonly clock: Clock, private readonly log: Logger) {
    this.channel = new NdjsonOwnedProcess(process, clock, (value) => {
      if (!isHostReply(value)) throw new TransportError("cursor", "worker", "Cursor SDK host sent an unknown frame")
      this.receive(value)
    }, (reason, cause) => new TransportError("cursor", "worker",
        reason === "frame" ? "Cursor SDK host sent an invalid frame" : `Cursor SDK host ${reason} failed`, { cause }),
      (error) => log.error("Cursor SDK host retirement failed", { error: errorMessage(error) }))
    this.channel.onFailure((error) => this.fail(error instanceof TransportError ? error
      : new TransportError("cursor", "worker", "Cursor SDK host failed", { cause: error })))
    process.stderr.on("data", (chunk: Buffer) => { this.stderrBytes += chunk.byteLength })
  }

  get failed() { return this.failure !== undefined }

  private receive(reply: HostReply) {
    const onEvent = this.pending.get(reply.id)
    if (reply.kind === "event") { onEvent?.(reply); return }
    if (reply.kind === "error") this.pending.reject(reply.id, new TransportError("cursor", "sdk", reply.message))
    else this.pending.resolve(reply.id, reply)
  }

  private fail(error: TransportError) {
    if (this.failure) return
    this.failure = error
    this.pending.fail(error)
  }

  private retireOnSilence() {
    void this.retire().catch((error: unknown) => this.log.error("Cursor SDK host retirement failed", { error: errorMessage(error) }))
  }

  private interruptSilentRun(sessionId: string) {
    void this.call({ kind: "cancel", sessionId }).then(undefined,
      (error: unknown) => this.log.warn("Cursor run cancellation after inactivity failed", { error: errorMessage(error) }))
  }

  private streamed(id: number, command: Extract<HostRequest, { kind: "run" | "title" }>, onEvent?: (reply: HostReply) => void, deadline?: Deadline): Promise<HostReply> {
    const idleMs = deadline ? Math.max(1, deadline.at - this.clock.now()) : RUN_IDLE_MS
    const countdown = new HoldableCountdown(this.clock, idleMs, () => {
      if (this.pending.reject(id, new TransportError("cursor", "worker", `Cursor ${command.kind} exceeded its inactivity deadline`))) {
        this.interruptSilentRun(command.session.sessionId)
      }
    })
    const request = this.pending.request(id, (reply) => { countdown.touch(); onEvent?.(reply) }, undefined,
      () => new TransportError("cursor", "worker", "Cursor SDK host did not answer"), () => this.channel.send({ ...command, id }))
    void request.then(() => countdown.dispose(), () => countdown.dispose())
    return request
  }

  call(command: HostRequest, onEvent?: (reply: HostReply) => void, deadline?: Deadline): Promise<HostReply> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    if (command.kind === "run" || command.kind === "title") return this.streamed(id, command, onEvent, deadline)
    const request = this.pending.request(id, onEvent, undefined, () => new TransportError("cursor", "worker", "Cursor SDK host did not answer"),
      () => this.channel.send({ ...command, id }))
    const limit = deadline ?? { at: this.clock.now() + COMMAND_MS, signal: new AbortController().signal }
    const abandon = command.kind === "cancel" || command.kind === "close" ? () => this.retireOnSilence() : () => {}
    return settleAtRequestDeadline(`Cursor ${command.kind}`, { deadlineAt: limit.at, signal: limit.signal }, request, abandon,
      (what) => new TransportError("cursor", "worker", `${what} exceeded its deadline`))
  }

  readonly retire = singleFlightUntil(async () => {
    const retired = new TransportError("cursor", "worker", "Cursor SDK host retired")
    this.fail(retired)
    this.channel.fail(retired, false)
    const outcome = await this.process.retire(retirementDeadline(this.clock))
    if (!outcome.stopped) throw new TransportError("cursor", "worker", `Cursor SDK host did not stop: ${outcome.error.message} (stderr ${this.stderrBytes} bytes)`)
  }, () => true)
}

type Slot = { host: CursorHost; users: number }

export class CursorHostRegistry {
  private readonly hosts = new Map<string, Slot>()

  constructor(private readonly services: HarnessServices, private readonly env: NodeJS.ProcessEnv) {}

  private async spawn(key: CursorHostKey): Promise<CursorHost> {
    const owned = await this.services.spawn({ file: process.execPath, args: [HOST_SCRIPT], cwd: key.home,
      env: cursorHostEnvironment(this.env, key.home, key.backendUrl) }, { role: "harness", label: "Cursor SDK host" })
    return new CursorHost(owned, this.services.clock, this.services.log)
  }

  private async live(key: CursorHostKey): Promise<Slot> {
    const id = cursorHostId(key)
    const current = this.hosts.get(id)
    if (current && !current.host.failed) return current
    const slot = { host: await this.spawn(key), users: current?.users ?? 0 }
    this.hosts.set(id, slot)
    return slot
  }

  async acquire(key: CursorHostKey): Promise<CursorHost> {
    const slot = await this.live(key)
    slot.users += 1
    return slot.host
  }

  current(key: CursorHostKey): Promise<CursorHost> {
    return this.live(key).then((slot) => slot.host)
  }

  existing(key: CursorHostKey): CursorHost | undefined {
    const slot = this.hosts.get(cursorHostId(key))
    return slot && !slot.host.failed ? slot.host : undefined
  }

  async release(key: CursorHostKey): Promise<void> {
    const id = cursorHostId(key)
    const slot = this.hosts.get(id)
    if (!slot) return
    slot.users = Math.max(0, slot.users - 1)
    if (slot.users > 0) return
    this.hosts.delete(id)
    await slot.host.retire()
  }

  async replace(key: CursorHostKey): Promise<void> {
    const id = cursorHostId(key)
    const slot = this.hosts.get(id)
    if (!slot) return
    this.hosts.delete(id)
    await slot.host.retire()
  }

  async dispose(): Promise<void> {
    const slots = [...this.hosts.values()]
    this.hosts.clear()
    await Promise.all(slots.map((slot) => slot.host.retire()))
  }
}
