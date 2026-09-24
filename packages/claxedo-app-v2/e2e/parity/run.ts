import { spawn } from "node:child_process"
import path from "node:path"
import { TSX_LOADER } from "../harness/node-loader"

const child = spawn("node", ["--import", TSX_LOADER, path.join(import.meta.dirname, "capture.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, CLAXEDO_E2E_APP: "v2" },
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
