import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import { ExecutionCapabilitiesUnavailableError } from "@claxedo/workgraph/ports"
import { WorkGraphConnectionToolNames, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import { OPENCODE_INTERNAL_BASE } from "../opencode-engine"
import { createExecutionCapabilitiesPort } from "./execution-capabilities"

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
      isolation: ["stream", "child"],
      cleanup: ["destroy_on_close", "retain"],
      integration: ["manual"],
    },
    readRuntime: async () => {
      const harness = await input.harness()
      if (harness !== "opencode") {
        throw new ExecutionCapabilitiesUnavailableError(
          "harnesses",
          "catalog_workspace_unavailable",
          `The configured ${harness} harness requires a provisioned Workspace Runtime catalog`,
          false,
        )
      }
      const [agents, providers, tools] = await Promise.all([
        runtimeJson(input, "/agent"),
        runtimeJson(input, "/provider"),
        runtimeJson(input, "/experimental/tool/ids"),
      ])
      return { harness: { harness }, agents, providers, tools }
    },
    readRepository: async () => {
      const run = promisify(execFile)
      await run("git", ["-C", input.repositoryDirectory, "rev-parse", "--verify", "HEAD^{commit}"])
      const [refs, remoteUrl] = await Promise.all([
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
      return (await input.connections.list({
        owner: context.ownerUserId,
        teamOwner: input.resolveTeamOwner?.(context),
      })).flatMap((connection) => connection.status === "connected" ? [{
        id: connection.id as never,
        integrationId: connection.integrationId,
        scope: connection.scope,
        ...(connection.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        grantedCapabilities: connection.grantedCapabilities,
      }] : [])
    },
    connectionToolIds: WorkGraphConnectionToolNames,
    ...(input.now ? { now: input.now } : {}),
  })
}

async function runtimeJson(input: Readonly<{ opencodeRequest: OpenCodeRequestFn; repositoryDirectory: string }>, pathname: string) {
  const response = await input.opencodeRequest(new Request(new URL(pathname, OPENCODE_INTERNAL_BASE), {
    headers: { "x-opencode-directory": input.repositoryDirectory },
    signal: AbortSignal.timeout(5_000),
  }))
  if (!response.ok) throw new Error(`Execution runtime catalog ${pathname} failed with ${response.status}`)
  return response.json()
}
