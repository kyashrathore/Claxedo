import { spawn } from "node:child_process"
import path from "node:path"
import { TSX_LOADER } from "../../../harness/e2e/harness/node-loader"

const child = spawn("node", ["--conditions=development", "--import", TSX_LOADER, path.join(import.meta.dirname, "stream.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
