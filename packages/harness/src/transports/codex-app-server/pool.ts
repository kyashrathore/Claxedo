import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger } from "../../contract"
import { CodexTransportError } from "./errors"
import type { CodexProcess } from "./launch"

export type CodexLease = { process: CodexProcess; release(): Promise<void> }

type PoolEntry = { key: string; process: Promise<CodexProcess>; members: number; idle?: unknown; evicted: boolean }

const CAPACITY = 8

export class CodexProcessPool {
  private readonly entries = new Map<string, PoolEntry[]>()
  private readonly disposal = new AbortController()

  constructor(private readonly clock: Clock, private readonly log: Logger, private readonly idleMs = 30_000) {}

  async acquire(key: string, create: (signal: AbortSignal) => Promise<CodexProcess>): Promise<CodexLease> {
    if (this.disposal.signal.aborted) throw new CodexTransportError("process", "Codex app-server pool disposed")
    const entry = this.entries.get(key)?.find((candidate) => candidate.members < CAPACITY) ?? this.create(key, create)
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

  private create(key: string, create: (signal: AbortSignal) => Promise<CodexProcess>): PoolEntry {
    const entry: PoolEntry = { key, process: create(this.disposal.signal), members: 0, evicted: false }
    this.entries.set(key, [...this.entries.get(key) ?? [], entry])
    entry.process.then((process) => { process.rpc.onFailure(() => this.evict(entry)) }, () => this.evict(entry))
    return entry
  }

  private async release(entry: PoolEntry): Promise<void> {
    entry.members -= 1
    if (entry.members > 0 || entry.evicted) return
    if (this.idleMs === 0) return this.retire(entry)
    entry.idle = this.clock.setTimeout(() => {
      void this.retire(entry).then(undefined, (error: unknown) => this.log.error("Codex idle app-server retirement failed", { key: entry.key, error: errorMessage(error) }))
    }, this.idleMs)
  }

  private evict(entry: PoolEntry): void {
    entry.evicted = true
    this.clock.clearTimeout(entry.idle)
    const remaining = (this.entries.get(entry.key) ?? []).filter((candidate) => candidate !== entry)
    if (remaining.length) this.entries.set(entry.key, remaining)
    else this.entries.delete(entry.key)
  }

  private async retire(entry: PoolEntry): Promise<void> {
    this.evict(entry)
    const process = await entry.process.catch((error: unknown) => {
      this.log.debug("Codex app-server never started, so there is nothing to retire", { key: entry.key, error: errorMessage(error) })
      return undefined
    })
    await process?.rpc.retire({ at: this.clock.now() + 10_000, signal: new AbortController().signal })
  }
}
