import fs from "node:fs"
import path from "node:path"

import { Miniflare } from "miniflare"

const ROOT = path.resolve(import.meta.dirname, "../..")
const workerFile = path.join(ROOT, "dist-worker/worker.js")
if (!fs.existsSync(workerFile)) throw new Error(`built Workerd entry is missing: ${workerFile}`)

const miniflare = new Miniflare({
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  modules: [{ type: "ESModule", path: "worker.js", contents: fs.readFileSync(workerFile, "utf8") }],
})
try {
  const response = await miniflare.dispatchFetch("http://boundary.test/api/claxedo/health")
  const body = await response.text()
  if (response.status !== 503) {
    throw new Error(`unconfigured built Workerd entry must fail closed with 503; got ${response.status}: ${body}`)
  }
  console.log("[server-workerd] built entry loaded and failed closed")
} finally {
  await miniflare.dispose()
}
