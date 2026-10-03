import { errorMessage } from "@claxedo/helpers"
import type { Clock, Deadline, Logger } from "../../contract"
import { CodexTransportError } from "./errors"
import type { CodexProcess } from "./launch"

export type PooledCodex = { rpc: { onFailure(listener: (error: Error) => void): () => void; retire(deadline: Deadline): Promise<void> } }

export type CodexLease<T> = { process: T; release(): Promise<void> }

type PoolEntry<T> = { key: string; process: Promise<T>; members: number; idle?: unknown; evicted: boolean }

export type CodexPoolOptions = { clock: Clock; log: Logger; idleMs?: number; capacity?: number }

export class CodexProcessPool<T extends PooledCodex = CodexProcess> {
  private readonly entries = new Map<string, PoolEntry<T>[]>()
  private readonly disposal = new AbortController()
  private readonly clock: Clock
  private readonly log: Logger
  private readonly idleMs: number
  private readonly capacity: number

  constructor(options: CodexPoolOptions) {
    this.clock = options.clock
    this.log = options.log
    this.idleMs = options.idleMs ?? 30_000
    this.capacity = options.capacity ?? 8
  }

  async acquire(key: string, create: (signal: AbortSignal) => Promise<T>): Promise<CodexLease<T>> {
    if (this.disposal.signal.aborted) throw new CodexTransportError("process", "Codex app-server pool disposed")
    const entry = this.entries.get(key)?.find((candidate) => candidate.members < this.capacity) ?? this.create(key, create)
    this.clock.clearTimeout(entry.idle)
    entry.idle = undefined
    entry.members += 1
    let released = false
    try {
      return { process: await entry.process, release: () => {
        if (released) return Promise.resolve()
        released = true
        return this.release(entry)
      } }
    } catch (error) {
      entry.members -= 1
      throw error
    }
  }

  async dispose(): Promise<void> {
    this.disposal.abort()
    const entries = [...this.entries.values()].flat()
    await Promise.all(entries.map((entry) => this.retire(entry)))
  }

  private create(key: string, create: (signal: AbortSignal) => Promise<T>): PoolEntry<T> {
    const entry: PoolEntry<T> = { key, process: create(this.disposal.signal), members: 0, evicted: false }
    this.entries.set(key, [...this.entries.get(key) ?? [], entry])
    entry.process.then((process) => { process.rpc.onFailure(() => this.evict(entry)) }, () => this.evict(entry))
    return entry
  }

  private async release(entry: PoolEntry<T>): Promise<void> {
    entry.members -= 1
    if (entry.members > 0 || entry.evicted) return
    if (this.idleMs === 0) return this.retire(entry)
    entry.idle = this.clock.setTimeout(() => {
      void this.retire(entry).then(undefined, (error: unknown) => this.log.error("Codex idle app-server retirement failed", { key: entry.key, error: errorMessage(error) }))
    }, this.idleMs)
  }

  private evict(entry: PoolEntry<T>): void {
    entry.evicted = true
    this.clock.clearTimeout(entry.idle)
    const remaining = (this.entries.get(entry.key) ?? []).filter((candidate) => candidate !== entry)
    if (remaining.length) this.entries.set(entry.key, remaining)
    else this.entries.delete(entry.key)
  }

  private async retire(entry: PoolEntry<T>): Promise<void> {
    this.evict(entry)
    const process = await entry.process.catch((error: unknown) => {
      this.log.debug("Codex app-server never started, so there is nothing to retire", { key: entry.key, error: errorMessage(error) })
      return undefined
    })
    await process?.rpc.retire({ at: this.clock.now() + 10_000, signal: new AbortController().signal })
  }
}
