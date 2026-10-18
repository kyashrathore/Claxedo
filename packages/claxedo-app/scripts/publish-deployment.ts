import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { publishDeployment, readPublishedDeployment } from "../published-deployment"

const [apiOrigin, distDir] = process.argv.slice(2)
if (!apiOrigin || !distDir) throw new Error("usage: bun scripts/publish-deployment.ts <api origin> <dist directory>")
const shell = path.join(distDir, "index.html")
const deployment = await readPublishedDeployment(apiOrigin)
await writeFile(shell, publishDeployment(await readFile(shell, "utf8"), deployment))
console.log(`Published ${deployment.server}'s bootstrap and auth descriptor into ${shell}`)
