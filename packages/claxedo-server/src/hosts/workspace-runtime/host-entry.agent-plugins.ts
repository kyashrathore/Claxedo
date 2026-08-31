#!/usr/bin/env node
/** Enabled VM image entry. The default host entry has no Agent Plugins import. */
import fs from "node:fs"
import { startServer, waitForWorkspaceRuntimeServerPort } from "@claxedo/workspace-runtime"
import { agentPluginWorkspaceRuntimeContribution } from "@claxedo/local-server/agent-plugins/runtime/runtime-contribution"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

if (process.argv[2] === "--version") {
  console.log(fs.readFileSync(new URL("./workspace-runtime-version", import.meta.url), "utf8").trim())
  process.exit(0)
}

const boot = await claxedoWorkspaceRuntimeBootFromEnv(process.env, {
  routeContributions: [agentPluginWorkspaceRuntimeContribution()],
})
const server = startServer(boot.port, boot.options, { signals: true })

console.log(
  `[claxedo-workspace-runtime] listening on http://${boot.hostname}:${await waitForWorkspaceRuntimeServerPort(server, boot.port)} workspaceId=${boot.options.target?.workspaceId} directory=${boot.options.target?.directory}`,
)
