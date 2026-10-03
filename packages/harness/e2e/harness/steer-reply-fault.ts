import fs from "node:fs/promises"
import path from "node:path"
import { writeLineProxyFault } from "./line-proxy-fault"
import { PINNED_CODEX } from "./pinned-codex"

export async function withholdSteerReply(dataDir: string, harness: "codex") {
  const bin = path.join(dataDir, `${harness}-steer-fault-bin`)
  await fs.mkdir(bin)
  const gate = path.join(bin, "withhold")
  if (process.env.CLAXEDO_E2E_H7_UNKNOWN_PASSTHROUGH !== "1") await fs.writeFile(gate, "")
  return writeLineProxyFault({
    dataDir,
    binName: `${harness}-steer-fault-bin`,
    executableName: "codex",
    actual: PINNED_CODEX,
    setup: `import fs from "node:fs"\nconst withheld = new Set()`,
    onRequest: `if (request.method === "turn/steer" && fs.existsSync(${JSON.stringify(gate)})) {
      withheld.add(request.id)
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "steer " + line + "\\n")
    }`,
    onReply: `if (withheld.delete(reply.id)) {
      fs.appendFileSync(${JSON.stringify(path.join(bin, "seen.log"))}, "reply withheld\\n")
      return false
    }`,
  })
}
