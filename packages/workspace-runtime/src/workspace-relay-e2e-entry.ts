/**
 * Test-only process entrypoint for `workspace-relay-e2e.test.ts`.
 *
 * The relay e2e's process-separated harness needs a real child process to
 * prove relay-host gating works across a process boundary. The kit ships no
 * bin and no boot-policy ladder — hosts own those — so this fixture composes
 * exactly what the e2e scenarios need from the public parsers: relay-host
 * auth from env with a loopback fallback.
 */
import { isLoopbackHostname, startServer, waitForWorkspaceRuntimeServerPort, workspaceRuntimeListenHostname } from "./server"
import { workspaceDir, workspaceId } from "./target"
import { workspaceRelayRuntimeOptionsFromEnv } from "./workspace-relay-env"
import {
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "./exposure"

const port = parseInt(process.env.WORKSPACE_RUNTIME_PORT?.trim() || "3002", 10)
const hostname = workspaceRuntimeListenHostname()
const relayOptions = await workspaceRelayRuntimeOptionsFromEnv(process.env, port)

const server = startServer(port, {
  target: { workspaceId: workspaceId(), directory: workspaceDir() },
  ...relayOptions,
  exposure: relayOptions.relayHostAuth
    ? relayWorkspaceRuntimeExposure(relayOptions.relayHostAuth)
    : isLoopbackHostname(hostname)
      ? loopbackWorkspaceRuntimeExposure()
      : privateNetworkDevUnsafeWorkspaceRuntimeExposure("relay e2e fixture"),
  harness: { id: "opencode", access: "native" },
  opencodeCompat: true,
}, { signals: true })

console.log(
  `[workspace-runtime] listening on http://${hostname}:${await waitForWorkspaceRuntimeServerPort(server, port)} workspaceId=${workspaceId()} directory=${workspaceDir()}`,
)
