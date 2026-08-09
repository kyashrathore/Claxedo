import fs from "node:fs/promises"
import path from "node:path"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"

const loaded = new Map<string, Promise<string>>()

/** Stable, local-only ledger identity. It is not an account or enrollment credential. */
export function localUsageHostId() {
  const target = path.join(dataDir(), "usage-host-id")
  const current = loaded.get(target)
  if (current) return current
  const pending = (async () => {
    const existing = await fs.readFile(target, "utf8").catch(() => undefined)
    if (existing?.trim()) return existing.trim()
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const value = `local_${crypto.randomUUID()}`
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, `${value}\n`, { mode: 0o600 })
    try {
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      const concurrent = await fs.readFile(target, "utf8").catch(() => undefined)
      if (concurrent?.trim()) return concurrent.trim()
      throw error
    }
    return value
  })()
  loaded.set(target, pending)
  void pending.catch(() => {
    if (loaded.get(target) === pending) loaded.delete(target)
  })
  return pending
}
