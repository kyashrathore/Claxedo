import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { normalizeHarnessIdentity, sdkModelOptions } from "@claxedo/agent-sdk-runtime"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import { WorkGraphConnectionToolNames, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { OPENCODE_INTERNAL_BASE } from "../opencode-engine"
import { piProviderCatalog } from "../pi-provider-catalog"
import { createExecutionCapabilitiesPort } from "./execution-capabilities"

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
  repositoryDirectory: string
  harness(): Promise<string>
  connections?: ConnectionsService
  resolveTeamOwner?: (context: WorkGraphContext) => string | undefined
  now?: () => number
}>) {
  return createExecutionCapabilitiesPort({
    environment: {
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    },
    readRuntime: async () => {
      const [activeHarness, agents, providers, tools] = await Promise.all([
        input.harness(),
        runtimeJson(input, "/agent"),
        runtimeJson(input, "/provider"),
        runtimeJson(input, "/experimental/tool/ids"),
      ])
      const harnesses = [
        ...SESSION_COMPOSER_HARNESSES.map((harness) => ({
          harness: { harness },
          agents: defaultAgent(harness),
          providers: sdkProviders(harness),
          tools: [],
          connectionTools: false,
        })),
        {
          harness: { harness: "pi" },
          agents: defaultAgent("pi"),
          providers: withDefaultEffort(piProviderCatalog()),
          tools: [],
          connectionTools: false,
        },
        { harness: { harness: "opencode" }, agents, providers, tools },
      ]
      const preferred = composerHarness(activeHarness)
      return {
        harnesses: preferred
          ? [...harnesses.filter((catalog) => catalog.harness.harness === preferred), ...harnesses.filter((catalog) => catalog.harness.harness !== preferred)]
          : harnesses,
      }
    },
    readRepository: async () => {
      const run = promisify(execFile)
      const [, refs, remoteUrl] = await Promise.all([
        run("git", ["-C", input.repositoryDirectory, "rev-parse", "--verify", "HEAD^{commit}"]),
        run("git", [
          "-C",
          input.repositoryDirectory,
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes",
        ]).then((result) => result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)),
        run("git", ["-C", input.repositoryDirectory, "remote", "get-url", "origin"])
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

function defaultAgent(harness: string) {
  return [{ name: "build", description: `Use the ${harness} harness default agent`, mode: "primary" }]
}

function sdkProviders(harness: string) {
  const identity = normalizeHarnessIdentity(harness)
  if (!identity || identity.id === "opencode" || identity.id === "pi") {
    throw new Error(`Unsupported SDK Session harness ${harness}`)
  }
  return {
    connected: [harness],
    all: [{
      id: harness,
      models: Object.fromEntries(sdkModelOptions(identity.id).map((model) => [model.id, {
        ...model,
        status: "active",
        variants: { low: {}, medium: {}, high: {} },
      }])),
    }],
  }
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

async function runtimeJson(input: Readonly<{ opencodeRequest: OpenCodeRequestFn; repositoryDirectory: string }>, pathname: string) {
  const response = await input.opencodeRequest(new Request(new URL(pathname, OPENCODE_INTERNAL_BASE), {
    headers: { "x-opencode-directory": input.repositoryDirectory },
    signal: AbortSignal.timeout(5_000),
  }))
  if (!response.ok) throw new Error(`Execution runtime catalog ${pathname} failed with ${response.status}`)
  return response.json()
}
