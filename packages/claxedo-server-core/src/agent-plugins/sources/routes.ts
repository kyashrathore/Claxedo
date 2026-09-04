import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { CLAXEDO_PUBLIC_GITHUB_COLLECTION, gitHubRepositorySlug, type AgentPluginSourceFetch } from "./github-public"
import {
  agentPluginSourceRecord,
  parseAgentPluginSourceRegistration,
  probeAgentPluginSource,
  type AgentPluginSourceProviderCache,
  type AgentPluginSourceRecord,
} from "./registry"

type Fetch = AgentPluginSourceFetch

/** What every registry failure a route can answer is called. */
export type AgentPluginSourceRegistryErrorCode =
  | "source-exists"
  | "source-unknown"
  | "source-forbidden"
  | "source-not-removable"

export class AgentPluginSourceRegistryError extends Error {
  constructor(readonly code: AgentPluginSourceRegistryErrorCode, message: string) {
    super(message)
    this.name = "AgentPluginSourceRegistryError"
  }
}

const STATUS: Record<AgentPluginSourceRegistryErrorCode, ContentfulStatusCode> = {
  "source-exists": 409,
  "source-unknown": 404,
  "source-forbidden": 403,
  "source-not-removable": 403,
}

/** One row of `GET /sources`, as the Directory renders it. */
export type AgentPluginSourceView = {
  id: string
  kind: AgentPluginSourceRecord["kind"]
  label: string
  repository: string
  ref: string
  authority?: AgentPluginSourceRecord["authority"]
  addedAt?: number
  canRemove: boolean
}

/** The built-in Claxedo collection, shown as a source the user cannot remove. */
export const CLAXEDO_BUILT_IN_SOURCE: AgentPluginSourceView = {
  id: CLAXEDO_PUBLIC_GITHUB_COLLECTION.id,
  kind: CLAXEDO_PUBLIC_GITHUB_COLLECTION.kind,
  label: CLAXEDO_PUBLIC_GITHUB_COLLECTION.label,
  repository: gitHubRepositorySlug(
    CLAXEDO_PUBLIC_GITHUB_COLLECTION.owner,
    CLAXEDO_PUBLIC_GITHUB_COLLECTION.repository,
  ),
  ref: CLAXEDO_PUBLIC_GITHUB_COLLECTION.ref,
  canRemove: false,
}

/**
 * The durable half of the registry, owned by each rail.
 *
 * `Actor` is whatever the rail resolved from the request: the signed rail
 * passes the authenticated caller, the unsigned rail has one machine actor and
 * passes nothing. Authorization lives behind this port because only the rail
 * knows what an organization is.
 */
export type AgentPluginSourceRegistry<Actor> = {
  list(actor: Actor): Promise<readonly AgentPluginSourceRecord[]>
  canRemove(actor: Actor, record: AgentPluginSourceRecord): Promise<boolean> | boolean
  /** Throws `source-exists` for a duplicate and `source-forbidden` without the role. */
  add(actor: Actor, record: AgentPluginSourceRecord): Promise<void>
  /** Throws `source-unknown` when nothing was removed and `source-forbidden` without the role. */
  remove(actor: Actor, id: string): Promise<void>
}

function body(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } }
}

/**
 * The `GET/POST/DELETE /api/claxedo/plugins/sources` family, shared by both rails.
 *
 * A registration is only saved after the repository has been read once and
 * served at least one valid plugin, because a source that lists nothing is
 * indistinguishable in the Directory from a broken one, and the diagnostics the
 * probe produces are exactly what the user needs to fix the address. The probe's
 * provider is adopted by the catalog's cache so the next catalog read reuses the
 * archive this request already downloaded.
 */
export function AgentPluginSourceRoutes<Actor>(input: {
  /** Sources the product always serves; not registered and never removable. */
  builtIn: readonly AgentPluginSourceView[]
  /** Signed rails report `authority` and accept `authority: "organization"`. */
  signed: boolean
  registry: AgentPluginSourceRegistry<Actor>
  cache: AgentPluginSourceProviderCache
  /** Resolves the caller; a rail with one machine actor answers it unconditionally. */
  authenticate: (request: Request) => Promise<
    { actor: Actor } | { error: unknown; status: ContentfulStatusCode }
  >
  /** Rail-specific failures (a signed rail's auth errors) rendered before rethrow. */
  errors?: (cause: unknown) => { body: unknown; status: ContentfulStatusCode } | undefined
  fetch?: Fetch
  now?: () => number
}) {
  const app = new Hono()
  const now = input.now ?? Date.now
  const actorOf = input.authenticate
  const view = (record: AgentPluginSourceRecord, canRemove: boolean): AgentPluginSourceView => ({
    id: record.id,
    kind: record.kind,
    label: record.label,
    repository: `${record.owner}/${record.repository}`,
    ref: record.ref,
    ...(input.signed ? { authority: record.authority } : {}),
    addedAt: record.addedAt,
    canRemove,
  })

  app.onError((cause, c) => {
    if (cause instanceof AgentPluginSourceRegistryError) {
      return c.json(
        body(`agent_plugins_${cause.code.replaceAll("-", "_")}`, cause.message),
        STATUS[cause.code],
      )
    }
    const mapped = input.errors?.(cause)
    if (mapped) return c.json(mapped.body, mapped.status)
    throw cause
  })

  app.get("/", async (c) => {
    const resolved = await actorOf(c.req.raw)
    if ("error" in resolved) return c.json(resolved.error, resolved.status)
    const records = await input.registry.list(resolved.actor)
    const sources: AgentPluginSourceView[] = [...input.builtIn]
    for (const item of records) sources.push(view(item, await input.registry.canRemove(resolved.actor, item)))
    return c.json({ sources })
  })

  app.post("/", async (c) => {
    const resolved = await actorOf(c.req.raw)
    if ("error" in resolved) return c.json(resolved.error, resolved.status)
    const registration = parseAgentPluginSourceRegistration(
      await c.req.json().catch(() => undefined),
      { signed: input.signed },
    )
    if (!registration) {
      return c.json(
        body("agent_plugins_source_invalid_body", "A source needs a GitHub owner and repository, and an optional ref"),
        400,
      )
    }
    const probe = await probeAgentPluginSource({
      registration,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    })
    if (probe.plugins === 0) {
      return c.json(
        body(
          "agent_plugins_source_empty",
          `${registration.owner}/${registration.repository}@${registration.ref} serves no valid Agent Plugin`,
          { diagnostics: probe.diagnostics },
        ),
        422,
      )
    }
    const record = agentPluginSourceRecord(registration, now())
    await input.registry.add(resolved.actor, record)
    input.cache.adopt(record.id, probe.provider)
    return c.json({
      source: view(record, await input.registry.canRemove(resolved.actor, record)),
      plugins: probe.plugins,
    }, 201)
  })

  app.delete("/:id{.+}", async (c) => {
    const resolved = await actorOf(c.req.raw)
    if ("error" in resolved) return c.json(resolved.error, resolved.status)
    const id = c.req.param("id")
    if (input.builtIn.some((source) => source.id === id)) {
      throw new AgentPluginSourceRegistryError("source-not-removable", `Source ${id} is built in and cannot be removed`)
    }
    await input.registry.remove(resolved.actor, id)
    return c.body(null, 204)
  })

  return app
}
