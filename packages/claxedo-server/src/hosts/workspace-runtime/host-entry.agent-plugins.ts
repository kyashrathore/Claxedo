#!/usr/bin/env node
/** Enabled VM image entry. The default host entry has no Agent Plugins import. */
import fs from "node:fs"
import { agentPluginWorkspaceRuntimeContribution } from "@claxedo/local-server/agent-plugins/runtime/runtime-contribution"
import { runWorkspaceRuntimeHost } from "./host-run"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

if (process.argv[2] === "--version") {
  console.log(fs.readFileSync(new URL("./workspace-runtime-version", import.meta.url), "utf8").trim())
  process.exit(0)
}

await runWorkspaceRuntimeHost(() => claxedoWorkspaceRuntimeBootFromEnv(process.env, {
  routeContributions: [agentPluginWorkspaceRuntimeContribution()],
}))
