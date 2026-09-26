import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { writeLineProxyFault } from "./line-proxy-fault"
import { PINNED_PI } from "./pinned-pi"
import { PINNED_CODEX } from "./pinned-codex"

export async function withholdSteerReply(dataDir: string, harness: "pi" | "codex") {
  const actual = harness === "pi" ? PINNED_PI : PINNED_CODEX
  const bin = path.join(dataDir, `${harness}-steer-fault-bin`)
  await fs.mkdir(bin)
  const gate = path.join(bin, "withhold")
  if (process.env.CLAXEDO_E2E_H7_UNKNOWN_PASSTHROUGH !== "1") await fs.writeFile(gate, "")
  return writeLineProxyFault({
    dataDir,
    binName: `${harness}-steer-fault-bin`,
    executableName: harness === "pi" ? "pi.mjs" : "codex",
    actual,
    setup: `import fs from "node:fs"\nconst withheld = new Set()`,
    onRequest: `if ((request.method === "turn/steer" || request.type === "steer") && fs.existsSync(${JSON.stringify(gate)})) {
      withheld.add(request.id)
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "steer " + line + "\\n")
    }`,
    onReply: `if (withheld.delete(reply.id)) {
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "reply withheld\\n")
      return false
    }`,
  })
}
