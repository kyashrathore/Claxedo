import { HoldableCountdown, createKeyedSerializer, errorMessage, settleAtRequestDeadline, singleFlightUntil, stringRecord } from "@claxedo/helpers"
import type { Clock, Deadline, HarnessServices, Logger, OwnedProcess, SpawnCommand } from "../../contract"
import { TransportError } from "../../contract/errors"
import { NdjsonOwnedProcess } from "../../rpc/channel"
import { PendingRpcRequests } from "../../rpc/pending"
import { cursorSdkFailure } from "./errors"
import { isHostReply, type HostReply, type HostRequest } from "./protocol"

export type CursorHostKey = { binding: string; home: string; backendUrl?: string }

export type CursorWorker = Pick<SpawnCommand, "file" | "args">

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
    if (reply.kind === "event" || reply.kind === "delta") { onEvent?.(reply); return }
    if (reply.kind === "error") this.pending.reject(reply.id, cursorSdkFailure(reply))
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
  private readonly serial = createKeyedSerializer()
  private readonly disposal = new AbortController()
  private readonly signal: AbortSignal

  constructor(private readonly services: HarnessServices, private readonly worker: CursorWorker, private readonly env: NodeJS.ProcessEnv, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.disposal.signal])
  }

  private unavailable() {
    return new TransportError("cursor", "worker", "Cursor SDK host registry disposed")
  }

  private async spawn(key: CursorHostKey, signal: AbortSignal): Promise<CursorHost> {
    const owned = await this.services.spawn({ file: this.worker.file, args: this.worker.args, cwd: key.home,
      env: cursorHostEnvironment(this.env, key.home, key.backendUrl) }, { role: "harness", label: "Cursor SDK host", home: key.home, signal })
    const host = new CursorHost(owned, this.services.clock, this.services.log)
    if (signal.aborted) {
      try { await host.retire() }
      catch (error) {
        this.services.log.error("Cursor late host retirement failed", { error: errorMessage(error) })
        throw error
      }
      throw this.unavailable()
    }
    return host
  }

  private async live(key: CursorHostKey): Promise<Slot> {
    if (this.signal.aborted) throw this.unavailable()
    const id = cursorHostId(key)
    const current = this.hosts.get(id)
    if (current && !current.host.failed) return current
    if (current) await current.host.retire()
    const abandoned = new AbortController()
    const spawning = this.spawn(key, AbortSignal.any([this.signal, abandoned.signal]))
    const host = await settleAtRequestDeadline("Cursor host spawn", { deadlineAt: this.services.clock.now() + COMMAND_MS, signal: this.signal },
      spawning, () => abandoned.abort(), (_what, aborted) => aborted ? this.unavailable()
        : new TransportError("cursor", "worker", "Cursor SDK host spawn exceeded its deadline"))
    if (this.signal.aborted) { await host.retire(); throw this.unavailable() }
    const slot = { host, users: 0 }
    this.hosts.set(id, slot)
    return slot
  }

  acquire(key: CursorHostKey): Promise<CursorHost> {
    return this.serial.run(cursorHostId(key), async () => {
      const slot = await this.live(key)
      if (this.signal.aborted) throw this.unavailable()
      slot.users += 1
      return slot.host
    })
  }

  existing(key: CursorHostKey): CursorHost | undefined {
    const slot = this.hosts.get(cursorHostId(key))
    return slot && !slot.host.failed ? slot.host : undefined
  }

  release(key: CursorHostKey, host: CursorHost): Promise<void> {
    return this.serial.run(cursorHostId(key), async () => {
      const id = cursorHostId(key)
      const slot = this.hosts.get(id)
      if (!slot || slot.host !== host) return
      slot.users -= 1
      if (slot.users > 0) return
      await slot.host.retire()
      if (this.hosts.get(id) === slot) this.hosts.delete(id)
    })
  }

  async dispose(): Promise<void> {
    this.disposal.abort()
    await Promise.all([...this.hosts].map(async ([id, slot]) => {
      await slot.host.retire()
      if (this.hosts.get(id) === slot) this.hosts.delete(id)
    }))
  }
}
