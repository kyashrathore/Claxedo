import fs from "node:fs/promises"
import type { DraftLaunch } from "./transport"

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

type ProbeEntry<T> = { result: Promise<T>; kept?: { signature: string; value: T } }

export class DraftProbeCache<T> {
  private readonly entries = new Map<string, ProbeEntry<T>>()

  constructor(private readonly maxEntries = 64) {}

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  get size(): number {
    return this.entries.size
  }

  async read(key: string, files: readonly string[], probe: () => Promise<T>): Promise<T> {
    const running = this.entries.get(key)
    if (running && !running.kept) return running.result
    const before = await probeInputSignature(files)
    const held = this.entries.get(key)
    if (held && (!held.kept || held.kept.signature === before)) return held.result
    const entry: ProbeEntry<T> = { result: probe() }
    this.remember(key, entry)
    try {
      const value = await entry.result
      const after = await probeInputSignature(files)
      if (this.entries.get(key) === entry) {
        if (after === before) entry.kept = { signature: after, value }
        else this.entries.delete(key)
      }
      return value
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    }
  }

  async peek(key: string, files: readonly string[]): Promise<T | undefined> {
    const held = this.entries.get(key)
    if (!held) return undefined
    if (!held.kept) return held.result
    if (held.kept.signature === await probeInputSignature(files)) return held.kept.value
    if (this.entries.get(key) === held) this.entries.delete(key)
    return undefined
  }

  private remember(key: string, entry: ProbeEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}
