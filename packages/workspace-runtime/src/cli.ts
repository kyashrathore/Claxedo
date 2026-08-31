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
import { runtimeEnvText } from "./env"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(pkg.version)
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
const nativeHarness = runtimeEnvText(process.env, "WORKSPACE_RUNTIME_NATIVE_HARNESS")
if (nativeHarness && !["claude", "codex", "cursor", "pi"].includes(nativeHarness)) {
  throw new Error(`Unsupported WORKSPACE_RUNTIME_NATIVE_HARNESS: ${nativeHarness}`)
}
const server = startServer(port, {
  target: { workspaceId: workspaceId(process.env), directory: workspaceDir(process.env) },
  ...relay,
  exposure: relay.relayHostAuth
    ? relayWorkspaceRuntimeExposure(relay.relayHostAuth)
    : isLoopbackHostname(hostname)
      ? loopbackWorkspaceRuntimeExposure()
      : privateNetworkDevUnsafeWorkspaceRuntimeExposure(
        "WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK managed runtime",
      ),
  harness: {
    id: identity.id,
    access: identity.access,
    ...(acpBinary ? { connection: { kind: "process" as const, binary: acpBinary } } : {}),
  },
  ...(runtimeEnvText(process.env, "OPENCODE_URL")
    ? { opencodeUrl: runtimeEnvText(process.env, "OPENCODE_URL") }
    : {}),
  // The kit CLI mounts NO route contributions. Host-supplied tool brokers are a
  // hosted capability supplied by a host launcher
  // (`claxedoWorkspaceRuntimeBootFromEnv`), not something a generic runtime
  // process turns on from an environment variable.
}, { signals: true })

console.log(
  `[workspace-runtime] listening on http://${hostname}:${await waitForWorkspaceRuntimeServerPort(server, port)}`
  + ` workspaceId=${workspaceId(process.env)} epoch=${runtimeEnvText(process.env, "WORKSPACE_RUNTIME_EPOCH") ?? "local"}`
  + ` directory=${workspaceDir(process.env)}`,
)
