#!/usr/bin/env node
/**
 * Claxedo's runnable workspace-runtime host.
 *
 * This is the process entrypoint baked into Claxedo sandbox images (bundled by
 * `scripts/sandbox/build-sandbox-image.ts`). Boot policy — the env→options
 * ladder — is Claxedo's own (`runtime-boot.ts`); the kit provides the parsers,
 * exposure factories, and `startServer`. Claxedo-specific host composition
 * deltas (custom stores, exposure guards, config hooks) belong here, not in
 * the public package.
 */
import { startServer, waitForWorkspaceRuntimeServerPort } from "@claxedo/workspace-runtime"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

const boot = await claxedoWorkspaceRuntimeBootFromEnv()
// This is Claxedo's runnable host process — it owns the process lifecycle, so
// it opts in to signal/exit handling (the kit default is off).
const server = startServer(boot.port, boot.options, { signals: true })

console.log(
  `[claxedo-workspace-runtime] listening on http://${boot.hostname}:${await waitForWorkspaceRuntimeServerPort(server, boot.port)} workspaceId=${boot.options.target?.workspaceId} directory=${boot.options.target?.directory}`,
)
