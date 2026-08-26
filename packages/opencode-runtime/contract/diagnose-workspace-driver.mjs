/**
 * DIAGNOSTIC ONLY — not a proposed implementation.
 *
 * Hypothesis for the location/project/config 500s: the public
 * `PromiseSdk.CreateOptions` is `Omit<EmbeddedHost.CreateOptions,
 * "workspaceProviders">`, and `dist/internal/host.js:16` only installs
 * `WorkspaceDriver.node` when `workspaceProviders` is passed:
 *
 *   workspaceProviders
 *     ? [...embed.overrides ?? [], [WorkspaceDriver.node, WorkspaceDriver.registryNode(workspaceProviders)]]
 *     : embed.overrides
 *
 * So a host built through the public entrypoint may have no workspace driver at
 * all, which would explain why every location-resolving surface fails while
 * pure session storage works.
 *
 * This script reaches into the internal host to CONFIRM THE CAUSE. Doing so in
 * product code is banned by Decision 15; the point here is to characterize the
 * gap precisely enough to report it upstream and decide the pin.
 *
 *   node diagnose-workspace-driver.mjs
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-diag-"))
const ws = path.join(root, "ws")
fs.mkdirSync(ws)

const { EmbeddedHost } = await import("@opencode-ai/sdk/dist/internal/host.js").catch(() => ({}))
if (!EmbeddedHost) {
  console.log("SKIP  internal host is not reachable as a subpath (expected: it is not in `exports`)")
  console.log("      The hypothesis stands on source reading of dist/internal/host.js:16.")
  process.exit(0)
}
console.log("NOTE  internal host WAS reachable — that itself is the Decision 15 hazard")
fs.rmSync(root, { recursive: true, force: true })
