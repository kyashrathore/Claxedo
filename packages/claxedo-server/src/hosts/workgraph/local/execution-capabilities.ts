import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { normalizeHarnessIdentity, sdkModelOptions } from "@claxedo/agent-sdk-runtime"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import { WorkGraphConnectionToolNames, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { ExecutionCapabilitiesUnavailableError } from "@claxedo/workgraph/ports"
import { OPENCODE_INTERNAL_BASE } from "@claxedo/server-core/opencode/engine"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
import { createExecutionCapabilitiesPort } from "../execution-capabilities"

const SESSION_COMPOSER_HARNESSES = [
  "claude-acp",
  "codex-acp",
  "cursor-acp",
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
] as const

export function createLocalExecutionCapabilities(input: Readonly<{
  opencodeRequest: OpenCodeRequestFn
  harness(): Promise<string>
  connections?: ConnectionsService
  resolveTeamOwner?: (context: WorkGraphContext) => string | undefined
  /**
   * Validates a caller-supplied project directory against the server's
   * authoritative known-projects list, returning the canonical absolute
   * directory to enumerate refs from — or `undefined` when the directory is not
   * a known project. Base-revision enumeration NEVER runs git against an
   * unvalidated path: an unknown directory fails closed with a typed repository
   * capability error.
   */
  resolveRepositoryDirectory?: (directory: string) => Promise<string | undefined> | string | undefined
  /**
   * Live harness config options (the same payload `/api/wr/harness-config-options`
   * serves the composer picker), used to populate live model catalogs from the
   * running harness instead of the static fallback catalog. Optional: absent or
   * failing, the static catalog is served exactly as before.
   */
  harnessConfigOptions?: (directory: string, harness: string) => Promise<unknown>
  now?: () => number
}>) {
  return createExecutionCapabilitiesPort({
    environment: {
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    },
    readRuntime: async (_context, request) => {
      const harnessConfigOptions = input.harnessConfigOptions
      const directory = resolveScopedRepositoryDirectory(input, request.directory)
      const [resolvedDirectory, activeHarness, runtime] = await Promise.all([
        directory,
        input.harness(),
        directory.then(async (selectedDirectory) => {
          if (!selectedDirectory) return [[], { connected: [], all: [] }, ["terminal"]] as const
          return Promise.all([
            runtimeJson(input, selectedDirectory, "/agent"),
            runtimeJson(input, selectedDirectory, "/api/model"),
            runtimeJson(input, selectedDirectory, "/experimental/tool/ids"),
          ])
        }),
      ])
      // Connection tools are advertised for every harness: Connection-bound
      // Runs execute through the harness-neutral runtime contribution
      // (`workGraphRuntimeRouteContributions`) on non-OpenCode harnesses and
      // through the engine's Session V2 bridge on OpenCode.
      const harnesses = [
        ...(await Promise.all(SESSION_COMPOSER_HARNESSES.map(async (harness) => ({
          harness: { harness },
          agents: defaultAgent(harness),
          providers: await sdkProviders(
            harness,
            resolvedDirectory && harnessConfigOptions
              ? (selectedHarness) => harnessConfigOptions(resolvedDirectory, selectedHarness)
              : undefined,
          ),
          tools: [],
        })))),
        {
          harness: { harness: "pi" },
          agents: defaultAgent("pi"),
          providers: withDefaultEffort(piProviderCatalog()),
          tools: [],
        },
        { harness: { harness: "opencode" }, agents: runtime[0], providers: runtime[1], tools: runtime[2] },
      ]
      const preferred = composerHarness(activeHarness)
      return {
        harnesses: preferred
          ? [...harnesses.filter((catalog) => catalog.harness.harness === preferred), ...harnesses.filter((catalog) => catalog.harness.harness !== preferred)]
          : harnesses,
      }
    },
    // Base-revision enumeration is always scoped to a caller-selected project.
    readRepository: async (_context, request) => {
      const directory = await resolveScopedRepositoryDirectory(input, request.directory)
      if (!directory) return { baseRevisions: [] }
      const run = promisify(execFile)
      const [, refs, remoteUrl] = await Promise.all([
        run("git", ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"]),
        run("git", [
          "-C",
          directory,
          "for-each-ref",
          "--format=%(refname:short)",
          "--sort=-committerdate",
          "refs/heads",
        ]).then((result) => result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)),
        run("git", ["-C", directory, "remote", "get-url", "origin"])
          .then((result) => result.stdout.trim() || undefined, () => undefined),
      ])
      return { ...(remoteUrl ? { remoteUrl } : {}), baseRevisions: ["HEAD", ...refs] }
    },
    readConnections: async (context) => {
      if (!input.connections) return []
      const teamOwner = input.resolveTeamOwner?.(context)
      return (await input.connections.list({
        owner: context.ownerUserId,
        teamOwner,
      })).flatMap((connection) => connection.status === "connected" && connection.scope === "team" ? [{
        id: connection.id as never,
        integrationId: connection.integrationId,
        scope: "team" as const,
        ...(connection.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        grantedCapabilities: connection.grantedCapabilities,
      }] : [])
    },
    connectionToolIds: WorkGraphConnectionToolNames,
    ...(input.now ? { now: input.now } : {}),
  })
}

/**
 * Resolves the directory whose refs base-revision enumeration should read.
 *
 * Fail-closed security invariant: git is never invoked against an arbitrary
 * caller-supplied path. A requested directory is honored only when it is an
 * absolute path that the server's authoritative known-projects validator
 * recognizes AND that exists on disk. Anything else throws a typed repository
 * capability error. An unscoped read has no repository catalog.
 */
async function resolveScopedRepositoryDirectory(
  input: Readonly<{
    resolveRepositoryDirectory?: (directory: string) => Promise<string | undefined> | string | undefined
  }>,
  requested: string | undefined,
) {
  const trimmed = requested?.trim()
  if (!trimmed) return undefined
  if (!input.resolveRepositoryDirectory || !path.isAbsolute(trimmed)) {
    throw unknownRepository(trimmed)
  }
  const resolved = (await input.resolveRepositoryDirectory(trimmed))?.trim()
  if (!resolved || !path.isAbsolute(resolved)) throw unknownRepository(trimmed)
  const exists = await stat(resolved).then((entry) => entry.isDirectory(), () => false)
  if (!exists) throw unknownRepository(trimmed)
  return resolved
}

function unknownRepository(directory: string) {
  return new ExecutionCapabilitiesUnavailableError(
    "repository",
    "repository_unavailable",
    `The requested project directory (${directory}) is not a known execution repository`,
    false,
  )
}

function defaultAgent(harness: string) {
  return [{ name: "build", description: `Use the ${harness} harness default agent`, mode: "primary" }]
}

async function sdkProviders(harness: string, harnessConfigOptions?: (harness: string) => Promise<unknown>) {
  const identity = normalizeHarnessIdentity(harness)
  if (!identity || identity.id === "opencode" || identity.id === "pi") {
    throw new Error(`Unsupported SDK Session harness ${harness}`)
  }
  const live = identity.access === "native" || (identity.id === "codex" && identity.access === "acp")
    ? await liveHarnessModels(harness, harnessConfigOptions)
    : undefined
  const models = live ?? sdkModelOptions(identity.id)
  return {
    connected: [harness],
    all: [{
      id: harness,
      models: Object.fromEntries(models.map((model) => [model.id, {
        ...model,
        status: "active",
        variants: { low: {}, medium: {}, high: {} },
      }])),
    }],
  }
}

async function liveHarnessModels(harness: string, harnessConfigOptions?: (harness: string) => Promise<unknown>) {
  if (!harnessConfigOptions) return
  const options = await harnessConfigOptions(harness).catch(() => undefined)
  if (!Array.isArray(options)) return
  const modelOption = options.find((option): option is Record<string, unknown> =>
    !!option && typeof option === "object" && (option as Record<string, unknown>).id === "model")
  const choices = modelOption && Array.isArray(modelOption.selectOptions)
    ? modelOption.selectOptions
    : modelOption && Array.isArray(modelOption.options)
      ? modelOption.options
      : []
  const models = choices.flatMap((option) => {
    const row = option && typeof option === "object" ? option as Record<string, unknown> : undefined
    const id = typeof row?.id === "string" && row.id
      ? row.id
      : typeof row?.value === "string" && row.value
        ? row.value
        : undefined
    if (!id) return []
    return [{
      id,
      name: typeof row?.name === "string" && row.name ? row.name : id,
      ...(typeof row?.description === "string" && row.description ? { description: row.description } : {}),
    }]
  })
  return models.length > 0 ? models : undefined
}

function composerHarness(input: string) {
  const identity = normalizeHarnessIdentity(input)
  if (!identity) return
  if (identity.access === "acp") return `${identity.id}-acp`
  if (identity.id === "claude") return "claude-sdk"
  if (identity.id === "codex") return "codex-app-server"
  if (identity.id === "cursor") return "cursor-sdk"
  return identity.id
}

function withDefaultEffort(catalog: ReturnType<typeof piProviderCatalog>) {
  return {
    ...catalog,
    all: catalog.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, {
        ...model,
        variants: { medium: {} },
      }])),
    })),
  }
}

/**
 * OpenCode-surface read: describes the OpenCode harness's OWN catalog entry
 * (agents, models, tool ids) over the engine transport. Re-homing this behind
 * the OpenCode adapter — so a cold engine serves a static entry instead of
 * booting — is owned by plan 2026-08-19-003 (U4); do not "fix" it here.
 */
async function runtimeJson(
  input: Readonly<{ opencodeRequest: OpenCodeRequestFn }>,
  directory: string,
  pathname: string,
) {
  const response = await input.opencodeRequest(new Request(new URL(pathname, OPENCODE_INTERNAL_BASE), {
    headers: { "x-opencode-directory": directory },
    signal: AbortSignal.timeout(5_000),
  }))
  if (!response.ok) throw new Error(`Execution runtime catalog ${pathname} failed with ${response.status}`)
  return response.json()
}
