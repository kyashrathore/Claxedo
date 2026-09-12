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
import fs from "node:fs"
import { runWorkspaceRuntimeHost } from "./host-run"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

if (process.argv[2] === "--version") {
  console.log(fs.readFileSync(new URL("./workspace-runtime-version", import.meta.url), "utf8").trim())
  process.exit(0)
}

// This is Claxedo's runnable host process — it owns the process lifecycle, so
// it opts in to signal/exit handling (the kit default is off).
await runWorkspaceRuntimeHost(() => claxedoWorkspaceRuntimeBootFromEnv())
