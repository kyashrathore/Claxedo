import { spawn } from "node:child_process"
import path from "node:path"
import { TSX_LOADER } from "../../../harness/e2e/harness/node-loader"

const [entry, ...args] = process.argv.slice(2)
if (!entry) throw new Error("name the measurement to run, relative to e2e/perf: stream.ts or web/main.ts")
const child = spawn("node", ["--conditions=development", "--import", TSX_LOADER, path.join(import.meta.dirname, entry), ...args], {
  stdio: "inherit",
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
