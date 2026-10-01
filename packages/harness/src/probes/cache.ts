import fs from "node:fs/promises"
import type { Clock } from "../contract/services"
import type { DraftLaunch } from "../contract/transport"

export type ProbeInputs = Readonly<{ files: readonly string[]; maxAge?: Readonly<{ ms: number; clock: Pick<Clock, "now"> }> }>

export function draftProbeKey(draft: DraftLaunch, ...extra: unknown[]): string {
  return JSON.stringify([draft.workspaceId, draft.directory, draft.locality, draft.owner, draft.config.harness, draft.model,
    draft.projection.generation, draft.credentials.leaseGeneration, ...extra])
}

async function stamp(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file)
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return "absent"
    throw error
  }
}

export async function probeInputSignature(files: readonly string[]): Promise<string> {
  return JSON.stringify(await Promise.all(files.map(async (file) => [file, await stamp(file)])))
}

type Expiry = { at: number; clock: Pick<Clock, "now"> }
type Kept<T> = { signature: string; expires?: Expiry; value: T }
type ProbeEntry<T> = { result: Promise<T>; kept?: Kept<T> }

function fresh(kept: Kept<unknown>, signature: string): boolean {
  return kept.signature === signature && (!kept.expires || kept.expires.clock.now() < kept.expires.at)
}

export class DraftProbeCache<T> {
  private readonly entries = new Map<string, ProbeEntry<T>>()

  constructor(private readonly maxEntries = 64) {}

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  get size(): number {
    return this.entries.size
  }

  async read(key: string, inputs: ProbeInputs, probe: () => Promise<T>): Promise<T> {
    const running = this.entries.get(key)
    if (running && !running.kept) return running.result
    const before = await probeInputSignature(inputs.files)
    const held = this.entries.get(key)
    if (held && (!held.kept || fresh(held.kept, before))) return held.result
    const expires = inputs.maxAge && { at: inputs.maxAge.clock.now() + inputs.maxAge.ms, clock: inputs.maxAge.clock }
    const entry: ProbeEntry<T> = { result: probe() }
    this.remember(key, entry)
    try {
      const value = await entry.result
      const after = await probeInputSignature(inputs.files)
      if (this.entries.get(key) === entry) {
        if (after === before) entry.kept = { signature: after, value, ...(expires ? { expires } : {}) }
        else this.entries.delete(key)
      }
      return value
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  async peek(key: string, inputs: ProbeInputs): Promise<T | undefined> {
    const held = this.entries.get(key)
    if (!held) return undefined
    if (!held.kept) return held.result
    if (fresh(held.kept, await probeInputSignature(inputs.files))) return held.kept.value
    if (this.entries.get(key) === held) this.entries.delete(key)
    return undefined
  }

  private remember(key: string, entry: ProbeEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}
