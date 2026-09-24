import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")
export const SERVER_DIR = path.join(REPO_ROOT, "packages/claxedo-server")

export const TSX_LOADER = pathToFileURL(
  path.join(path.dirname(createRequire(path.join(SERVER_DIR, "package.json")).resolve("tsx/package.json")), "dist/loader.mjs"),
).href
