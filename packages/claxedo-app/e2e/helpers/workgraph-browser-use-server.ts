import os from "node:os"
import path from "node:path"
import { createRealWorkGraphHarness } from "./real-workgraph-harness"

const port = Number(process.env.CLAXEDO_WORKGRAPH_BROWSER_API_PORT ?? 4312)
const temporaryRoot = process.env.CLAXEDO_WORKGRAPH_BROWSER_DATA
  ? path.resolve(process.env.CLAXEDO_WORKGRAPH_BROWSER_DATA)
  : os.tmpdir()
const harness = await createRealWorkGraphHarness({ port, temporaryRoot })
let closing = false

const close = async () => {
  if (closing) return
  closing = true
  await harness.close()
}

process.on("SIGINT", () => void close().finally(() => process.exit(0)))
process.on("SIGTERM", () => void close().finally(() => process.exit(0)))
console.log(`WorkGraph Browser Use server listening on ${harness.apiUrl}; data: ${harness.directory}`)
