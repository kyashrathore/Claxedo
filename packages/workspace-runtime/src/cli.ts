#!/usr/bin/env node

import { readFileSync } from "node:fs"
import {
  isLoopbackHostname,
  startServer,
  waitForWorkspaceRuntimeServerPort,
  workspaceRuntimeListenHostname,
} from "./server"
import { workspaceDir, workspaceId } from "./target"
import { workspaceRelayRuntimeOptionsFromEnv } from "./workspace-relay-env"
import {
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "./exposure"
import { runtimeEnvText, workspaceRuntimeEpoch } from "./env"
import { RUNTIME_NATIVE_HARNESS_IDS } from "./routes/config"
import { rec, str } from "./json-value"
import { createWorkspaceOpenCodeRuntime } from "./opencode-runtime"

const pkg = rec(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")))

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(str(pkg?.version) ?? "unknown")
  process.exit(0)
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: workspace-runtime [--help] [--version]")
  console.log("Starts @claxedo/workspace-runtime from WORKSPACE_RUNTIME_* environment variables.")
  process.exit(0)
}

const port = parseInt(runtimeEnvText(process.env, "WORKSPACE_RUNTIME_PORT") ?? "3002", 10)
const hostname = workspaceRuntimeListenHostname(process.env)
const relay = await workspaceRelayRuntimeOptionsFromEnv(process.env, port)
const nativeHarnessInput = runtimeEnvText(process.env, "WORKSPACE_RUNTIME_NATIVE_HARNESS")
// `find` over the canonical id list produces the literal type; the membership
// test below left a bare `string`, which is what forced the assertion.
const nativeHarness = RUNTIME_NATIVE_HARNESS_IDS.find((id) => id === nativeHarnessInput)
const connectionId = runtimeEnvText(process.env, "WORKSPACE_RUNTIME_CONNECTION_ID")
if (nativeHarnessInput && connectionId) throw new Error("Select either WORKSPACE_RUNTIME_NATIVE_HARNESS or WORKSPACE_RUNTIME_CONNECTION_ID")
if (nativeHarnessInput && !nativeHarness) {
  throw new Error(`Unsupported WORKSPACE_RUNTIME_NATIVE_HARNESS: ${nativeHarnessInput}`)
}
// A standalone runtime selecting the native OpenCode harness owns its public
// embedded-SDK runtime and closes it during process drain.
const directory = workspaceDir(process.env)
const opencodeRuntime = nativeHarness === "opencode" ? createWorkspaceOpenCodeRuntime(directory) : undefined
const server = startServer(port, {
  target: { workspaceId: workspaceId(process.env), directory },
  ...relay,
  exposure: relay.relayHostAuth
    ? relayWorkspaceRuntimeExposure(relay.relayHostAuth)
    : isLoopbackHostname(hostname)
      ? loopbackWorkspaceRuntimeExposure()
      : privateNetworkDevUnsafeWorkspaceRuntimeExposure(
        "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK managed runtime",
      ),
  ...(nativeHarness ? { harness: { kind: "native" as const, harnessId: nativeHarness } }
    : connectionId ? { harness: { kind: "connection" as const, connectionId } } : {}),
  ...(opencodeRuntime ? { opencodeRuntime, ownsOpenCodeRuntime: true } : {}),
  // The kit CLI mounts NO route contributions. Host-supplied tool brokers are a
  // hosted capability supplied by a host launcher
  // (`claxedoWorkspaceRuntimeBootFromEnv`), not something a generic runtime
  // process turns on from an environment variable.
}, { signals: true })

console.log(
  `[workspace-runtime] listening on http://${hostname}:${await waitForWorkspaceRuntimeServerPort(server, port)}`
  + ` workspaceId=${workspaceId(process.env)} epoch=${workspaceRuntimeEpoch(process.env) ?? "local"}`
  + ` directory=${workspaceDir(process.env)}`,
)
