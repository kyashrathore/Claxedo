import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isProviderUnavailable, providerBinding, type ProviderProjection } from "../../provider-projection"

/** One Pi `auth.json` row per provider. A brokered account routes through `models.json` instead, so this stays empty. */
export type PiAuthEntries = Record<string, { type: "api_key"; key: string }>

/** One `models.json` overlay per provider, merged onto Pi's own built-in definition. */
export type PiProviderOverrides = Record<string, { baseUrl: string; apiKey: string }>

/**
 * The providers Pi itself defines that this harness can bind, and the two facts
 * about each that the binding cannot supply.
 *
 * `includesApiPath` says whether Pi's own base URL for the provider already
 * reaches the vendor's API root — it ships `https://api.anthropic.com` for
 * `anthropic` and `https://api.openai.com/v1` for `openai`, and an overlay
 * replaces that URL whole. `env` names the variables Pi's built-in auth reads,
 * which a brokered launch withholds so the placeholder is the only credential
 * the process can send.
 */
const PI_PROVIDERS = {
  anthropic: {
    includesApiPath: false,
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  },
  openai: { includesApiPath: true, env: ["OPENAI_API_KEY"] },
} as const

/** The projections this harness consumes; every other key belongs to another harness. */
function piProjections(auth: Record<string, ProviderProjection> | undefined) {
  return Object.entries(PI_PROVIDERS).flatMap(([providerId, provider]) => {
    const projection = auth?.[providerId]
    return projection ? [{ providerId, provider, projection }] : []
  })
}

/**
 * The `models.json` provider overlays for the accounts this harness is bound to.
 *
 * An overlay carries the binding's base URL and its placeholder and nothing
 * else, because Pi merges it onto the built-in definition — the wire protocol
 * and the model list stay Pi's own.
 */
export function piProviderOverrides(auth: Record<string, ProviderProjection> | undefined): PiProviderOverrides {
  const overrides: PiProviderOverrides = {}
  for (const { providerId, provider, projection } of piProjections(auth)) {
    if (isProviderUnavailable(projection)) continue
    overrides[providerId] = {
      baseUrl: `${projection.baseUrl}${provider.includesApiPath ? projection.apiPath ?? "" : ""}`,
      apiKey: projection.placeholder,
    }
  }
  return overrides
}

/**
 * Refuse a launch on an account the operator selected and the provider will not
 * accept. Read here rather than at config time: an unusable account must fail
 * the turn, not the workspace's config apply.
 */
export function assertPiProvidersBindable(auth: Record<string, ProviderProjection> | undefined) {
  for (const { projection } of piProjections(auth)) providerBinding("pi", projection)
}

/**
 * The launch environment with every bound provider's own credential variables
 * removed, so the only credential the process can send is the placeholder in
 * `models.json`.
 */
export function piSpawnEnv(
  base: NodeJS.ProcessEnv,
  auth: Record<string, ProviderProjection> | undefined,
): NodeJS.ProcessEnv {
  const withheld = new Set<string>(piProjections(auth).flatMap(({ provider }) => [...provider.env]))
  return Object.fromEntries(Object.entries(base).filter(([name]) => !withheld.has(name)))
}

async function writeManaged(agentDir: string, name: string, content: unknown) {
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 })
  const file = path.join(agentDir, name)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(content), { mode: 0o600, flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export function writePiAuth(agentDir: string, entries: PiAuthEntries) {
  return writeManaged(agentDir, "auth.json", entries)
}

export function writePiModels(agentDir: string, providers: PiProviderOverrides) {
  return writeManaged(agentDir, "models.json", { providers })
}

const MANAGED_FILES = ["auth.json", "models.json"] as const

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
    write(entries: PiAuthEntries, providers: PiProviderOverrides = {}) {
      if (released) return Promise.reject(new Error("Pi auth profile is disposed"))
      return enqueue(async () => {
        await writePiAuth(directory, entries)
        await writePiModels(directory, providers)
      })
    },
    release() {
      if (released) return released
      profile.owners--
      released = enqueue(async () => {
        if (profile.owners) return
        for (const name of MANAGED_FILES) await fs.rm(path.join(directory, name), { force: true })
      })
      return released
    },
  }
}
