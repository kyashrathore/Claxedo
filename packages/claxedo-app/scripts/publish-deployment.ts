import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PUBLISHED_DOCUMENTS, publishDeployment, readPublishedDeployment } from "../published-deployment"

const [apiOrigin, distDir] = process.argv.slice(2)
if (!apiOrigin || !distDir) throw new Error("usage: bun scripts/publish-deployment.ts <api origin> <dist directory>")
const deployment = await readPublishedDeployment(apiOrigin)
for (const name of PUBLISHED_DOCUMENTS) {
  const document = path.join(distDir, name)
  await writeFile(document, publishDeployment(await readFile(document, "utf8"), deployment))
  console.log(`Published ${deployment.server}'s bootstrap and auth descriptor into ${document}`)
}
