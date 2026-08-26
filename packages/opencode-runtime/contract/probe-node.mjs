/**
 * Contract probe on Node, against the bundle produced by build-node-bundle.ts.
 * This is the path that proves the cutover is viable on the runtime every
 * Claxedo deployment actually ships (contract doc §2).
 *
 *   bun run build-node-bundle.ts && node probe-node.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import { runContract } from "./contract.mjs"

process.exit((await runContract(OpenCode)) ? 1 : 0)
