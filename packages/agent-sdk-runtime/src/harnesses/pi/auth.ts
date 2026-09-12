import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

/** One Pi `auth.json` row per provider. Nothing projects one yet, so the managed profile is written empty. */
export type PiAuthEntries = Record<string, { type: "api_key"; key: string }>

export async function writePiAuth(agentDir: string, entries: PiAuthEntries) {
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, "auth.json")
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

const profiles = new Map<string, { owners: number; operations: number; pending: Promise<void> }>()

/** Adapters in one host share a profile; only its final owner scrubs managed auth. */
export function retainPiAuth(agentDir: string) {
  const directory = path.resolve(agentDir)
  const profile = profiles.get(directory) ?? { owners: 0, operations: 0, pending: Promise.resolve() }
  profiles.set(directory, profile)
  profile.owners++
  let released: Promise<void> | undefined
  const enqueue = (operation: () => Promise<void>) => {
    profile.operations++
    const result = profile.pending.then(operation).finally(() => {
      profile.operations--
      if (!profile.owners && !profile.operations) profiles.delete(directory)
    })
    profile.pending = result.catch(() => {})
    return result
  }
  return {
    write(entries: PiAuthEntries) {
      if (released) return Promise.reject(new Error("Pi auth profile is disposed"))
      return enqueue(() => writePiAuth(directory, entries))
    },
    release() {
      if (released) return released
      profile.owners--
      released = enqueue(async () => {
        if (profile.owners) return
        await fs.rm(path.join(directory, "auth.json"), { force: true })
      })
      return released
    },
  }
}
