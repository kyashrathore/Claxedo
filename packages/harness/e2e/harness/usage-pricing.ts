import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"

const TOKEN_TRACKER = path.dirname(createRequire(path.join(REPO_ROOT, "packages/claxedo-local-server/package.json")).resolve("tokentracker-cli/package.json"))
const SEED = path.join(TOKEN_TRACKER, "src/lib/pricing/seed-snapshot.json")

export async function writePricingSnapshot(home: string) {
  const cache = path.join(home, ".tokentracker", "cache", "pricing.json")
  await fs.mkdir(path.dirname(cache), { recursive: true })
  await fs.writeFile(cache, await fs.readFile(SEED))
}
