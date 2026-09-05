/**
 * Contract probe against the published package. Requires Bun: the pinned
 * release ships extensionless relative ESM specifiers that Node cannot
 * resolve (contract doc §2). For the Node path use probe-node.mjs.
 *
 *   bun run probe.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import { runContract } from "./contract.mjs"

process.exit((await runContract(OpenCode)) ? 1 : 0)
