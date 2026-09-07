import { asRecord } from "@claxedo/agent-runtime-contract"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * Project registry credentials without giving Pi a second refresh-token owner.
 *
 * `codex-app-server` carries either a Codex OAuth bundle (JSON) or, when the
 * registry aliases the plain `openai` key into it, a bare API key. The bundle's
 * access token becomes Pi's `openai-codex` entry; a bare key is an OpenAI API
 * key, as the Codex harness reads it.
 */
export function piAuthProjection(auth: Record<string, unknown>) {
  const entries: Record<string, { type: "api_key"; key: string }> = {}
  for (const provider of ["anthropic", "openai"] as const) {
    const value = auth[provider]
    if (typeof value === "string" && value) entries[provider] = { type: "api_key", key: value }
  }
  const source = auth["codex-app-server"]
  if (typeof source === "string" && source) {
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      entries.openai ??= { type: "api_key", key: source }
      return entries
    }
    const row = asRecord(value)
    if (!row) throw new Error("Invalid Pi Codex credential object")
    const tokens = asRecord(row.tokens)
    const oauth = asRecord(row.oauth)
    const access = tokens?.access_token ?? row.access ?? oauth?.access
    const expires = row.expires ?? oauth?.expires
    if (typeof access === "string" && access) {
      if (typeof expires === "number" && expires <= Date.now())
        throw new Error("Pi Codex credential expired; refresh the connected credential")
      entries["openai-codex"] = { type: "api_key", key: access }
    }
  }
  return entries
}

export async function writePiAuth(agentDir: string, entries: ReturnType<typeof piAuthProjection>) {
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
    write(entries: ReturnType<typeof piAuthProjection>) {
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
