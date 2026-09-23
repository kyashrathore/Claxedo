import fs from "node:fs/promises"
import path from "node:path"
import { piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { isProviderUnavailable, providerBinding, type ProviderProjection } from "../../provider-projection"

/** One `models.json` overlay per provider, merged onto Pi's own built-in definition. */
export type PiProviderOverrides = Record<string, { baseUrl: string; apiKey: string }>

/**
 * The providers Pi itself defines that this harness can bind, and the two facts
 * about each that the binding cannot supply.
 *
 * `path` is the path of Pi 0.85.1's own base URL for the provider, which an
 * overlay replaces whole — so the overlay has to put it back under the binding
 * root or Pi sends the turn somewhere the binding does not allow. It is not the
 * binding's own `apiPath`: `openrouter` speaks the Anthropic wire protocol
 * under `https://openrouter.ai/api` and appends `/v1/messages` itself, while
 * the binding's API root is `/api/v1`. `env` names the variables Pi's built-in
 * auth reads, which a brokered launch withholds so the placeholder is the only
 * credential the process can send.
 */
const PI_PROVIDERS = {
  anthropic: {
    path: "",
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  },
  openai: { path: "/v1", env: ["OPENAI_API_KEY"] },
  openrouter: { path: "/api", env: ["OPENROUTER_API_KEY"] },
  google: { path: "/v1beta", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
  groq: { path: "/openai/v1", env: ["GROQ_API_KEY"] },
  xai: { path: "/v1", env: ["XAI_API_KEY"] },
} as const

/**
 * The projections this harness consumes; every other key belongs to another
 * harness.
 *
 * A projection map is keyed by the stored row's own provider id, so the row a
 * Pi provider runs on is not always the one named after it: a Claude Code
 * login is stored under `claude-sdk` and reaches Anthropic's API on the same
 * paths an `anthropic` key does. `piCredentialProviderIDs` is the same order
 * the credential catalog counts a provider connected in — held apart, Settings
 * called Anthropic connected and the launch then wrote it no overlay.
 */
function piProjections(auth: Record<string, ProviderProjection> | undefined) {
  return Object.entries(PI_PROVIDERS).flatMap(([providerId, provider]) => {
    for (const candidate of piCredentialProviderIDs(providerId)) {
      const projection = auth?.[candidate]
      if (projection) return [{ providerId, provider, projection }]
    }
    return []
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
      baseUrl: `${projection.baseUrl}${provider.path}`,
      apiKey: projection.placeholder,
    }
  }
  return overrides
}

/**
 * Refuse a launch on an account the operator selected and the provider will not
 * accept. Read here rather than at config time: an unusable account must fail
 * the turn, not the workspace's config apply.
 *
 * `model` is Pi's own `provider/id`. When it names one, only that provider's
 * account can be spent and only it is refused — one unusable Gemini account
 * would otherwise take every Claude turn in the workspace down with it. A
 * resume and the model probe carry no model, so those refuse on any of them.
 */
export function assertPiProvidersBindable(
  auth: Record<string, ProviderProjection> | undefined,
  model?: string,
) {
  const selected = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined
  for (const { providerId, projection } of piProjections(auth)) {
    if (selected && providerId !== selected) continue
    providerBinding("pi", projection)
  }
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
  await writePrivateFileAtomic(path.join(agentDir, name), JSON.stringify(content))
}

/**
 * Empty Pi's own credential file. A login stored there resolves ahead of the
 * `models.json` overlay, so leaving one in the profile would spend an account
 * the operator did not select for this workspace.
 */
function clearPiAuth(agentDir: string) {
  return writeManaged(agentDir, "auth.json", {})
}

function writePiModels(agentDir: string, providers: PiProviderOverrides) {
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
    write(providers: PiProviderOverrides) {
      if (released) return Promise.reject(new Error("Pi auth profile is disposed"))
      return enqueue(async () => {
        await clearPiAuth(directory)
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
