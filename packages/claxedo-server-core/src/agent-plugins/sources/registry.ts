import { resolveCollections } from "../catalog/resolve-collections"
import type { AgentPluginCatalogError, AgentPluginSourceKind } from "../catalog/types"
import type { CatalogSourceProvider } from "../ports"
import {
  githubRepositoryCatalogSourceProvider,
  type AgentPluginSourceFetch,
  gitHubRepositorySlug,
  isGitHubNameSegment,
  isGitHubRef,
} from "./github-public"

type Fetch = AgentPluginSourceFetch

/** The default ref a registration without one reads. */
export const AGENT_PLUGIN_SOURCE_DEFAULT_REF = "main"

/**
 * Who a registered source belongs to.
 *
 * The unsigned rail has one machine actor and therefore only `user`; the
 * signed rail also stores `organization` rows, which every member of the
 * organization reads and only an admin or owner may add or remove.
 */
export type AgentPluginSourceAuthority = "user" | "organization"

/** One repository a rail's registry has stored. */
export type AgentPluginSourceRecord = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  owner: string
  repository: string
  ref: string
  authority: AgentPluginSourceAuthority
  addedAt: number
}

/** A validated registration request; the shape both rails' POST bodies decode to. */
export type AgentPluginSourceRegistration = {
  owner: string
  repository: string
  ref: string
  authority: AgentPluginSourceAuthority
}

/**
 * The provider id a registered repository is read under.
 *
 * Stable across restarts and across rails because it is derived only from what
 * the user registered: an artifact pin records `sourceId`, so a derived id that
 * changed would orphan every retained plugin from its source.
 */
export function agentPluginSourceId(owner: string, repository: string, ref: string) {
  return `github:${gitHubRepositorySlug(owner, repository)}@${ref}`
}

/** The catalog source kind a stored authority presents as. */
export function agentPluginSourceKind(authority: AgentPluginSourceAuthority): AgentPluginSourceKind {
  return authority === "organization" ? "organization" : "personal"
}

/** Builds the stored record for a validated registration. */
export function agentPluginSourceRecord(
  registration: AgentPluginSourceRegistration,
  addedAt: number,
): AgentPluginSourceRecord {
  return {
    id: agentPluginSourceId(registration.owner, registration.repository, registration.ref),
    kind: agentPluginSourceKind(registration.authority),
    label: gitHubRepositorySlug(registration.owner, registration.repository),
    owner: registration.owner,
    repository: registration.repository,
    ref: registration.ref,
    authority: registration.authority,
    addedAt,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Decodes a `POST /sources` body.
 *
 * `signed` decides whether `authority` is meaningful: the unsigned rail has no
 * organization, so a body that names one is a client mistake rather than a
 * silently ignored field.
 */
export function parseAgentPluginSourceRegistration(
  value: unknown,
  options: { signed: boolean },
): AgentPluginSourceRegistration | undefined {
  if (!record(value)) return undefined
  const allowed = new Set(["owner", "repository", "ref", "authority"])
  if (!Object.keys(value).every((key) => allowed.has(key))) return undefined
  const owner = typeof value.owner === "string" ? value.owner.trim() : undefined
  const repository = typeof value.repository === "string" ? value.repository.trim() : undefined
  const ref = value.ref === undefined || value.ref === null
    ? AGENT_PLUGIN_SOURCE_DEFAULT_REF
    : typeof value.ref === "string" ? value.ref.trim() : undefined
  if (!owner || !repository || !ref) return undefined
  if (!isGitHubNameSegment(owner) || !isGitHubNameSegment(repository) || !isGitHubRef(ref)) return undefined
  if (value.authority !== undefined && value.authority !== null
    && value.authority !== "user" && value.authority !== "organization") return undefined
  const authority: AgentPluginSourceAuthority = options.signed && value.authority === "organization"
    ? "organization"
    : "user"
  return { owner, repository, ref, authority }
}

/**
 * Keeps one provider per registered source id for the life of the composition.
 *
 * A provider owns the fetched archive cache, so building a new one on every
 * catalog read would turn each read into a GitHub download. Ids that are no
 * longer registered are dropped, which is what makes a removed source stop
 * costing memory.
 */
export function createAgentPluginSourceProviderCache(fetch?: Fetch) {
  const providers = new Map<string, CatalogSourceProvider>()
  return {
    /** Providers for exactly these records, reusing every cached one. */
    resolve(records: readonly AgentPluginSourceRecord[]): CatalogSourceProvider[] {
      const live = new Set(records.map((item) => item.id))
      for (const id of providers.keys()) if (!live.has(id)) providers.delete(id)
      return records.map((item) => {
        const existing = providers.get(item.id)
        if (existing) return existing
        const created = githubRepositoryCatalogSourceProvider({
          id: item.id,
          kind: item.kind,
          label: item.label,
          owner: item.owner,
          repository: item.repository,
          ref: item.ref,
          ...(fetch ? { fetch } : {}),
        })
        providers.set(item.id, created)
        return created
      })
    },
    /** Adopts the provider a validation already paid for, so the next read is warm. */
    adopt(id: string, provider: CatalogSourceProvider) {
      providers.set(id, provider)
    },
    size: () => providers.size,
  }
}

export type AgentPluginSourceProviderCache = ReturnType<typeof createAgentPluginSourceProviderCache>

/**
 * The catalog's source list: the built-in collection plus every registered
 * repository, resolved on each read.
 *
 * Resolution happens per read rather than at composition time so a source added
 * through `POST /sources` appears in the next catalog read without a restart.
 * Duplicate ids are dropped keeping the first record (a rail orders
 * organization rows before personal ones), because `resolveCollections` refuses
 * a duplicate source id and one user's personal registration must not break the
 * whole catalog for them.
 */
export function agentPluginCatalogSources(input: {
  base: CatalogSourceProvider
  cache: AgentPluginSourceProviderCache
  list: () => Promise<readonly AgentPluginSourceRecord[]>
}): CatalogSourceProvider {
  return {
    async listAuthorizedSources(options = {}) {
      const seen = new Set<string>()
      const records = (await input.list()).filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      const providers = [input.base, ...input.cache.resolve(records)]
      const resolved = await Promise.all(providers.map((provider) => provider.listAuthorizedSources(options)))
      return resolved.flat()
    },
  }
}

export type AgentPluginSourceProbe = {
  /** How many valid plugins the repository serves at this ref. */
  plugins: number
  diagnostics: AgentPluginCatalogError[]
  provider: CatalogSourceProvider
}

/**
 * Reads a repository once to decide whether it may be registered.
 *
 * Registration is only meaningful when the repository actually serves a plugin,
 * and the only honest way to know is to run the same listing path a catalog
 * read runs. The provider is returned so the caller can hand it to the cache
 * instead of downloading the archive a second time.
 */
export async function probeAgentPluginSource(input: {
  registration: AgentPluginSourceRegistration
  fetch?: Fetch
}): Promise<AgentPluginSourceProbe> {
  const record = agentPluginSourceRecord(input.registration, 0)
  const provider = githubRepositoryCatalogSourceProvider({
    id: record.id,
    kind: record.kind,
    label: record.label,
    owner: record.owner,
    repository: record.repository,
    ref: record.ref,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  const resolved = await resolveCollections(provider, { fresh: true })
  return { plugins: resolved.candidates.length, diagnostics: resolved.errors, provider }
}
