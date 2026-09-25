import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "path"
import { pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/agent-runtime-contract"
import { readApiManifest, readPackageJson } from "./manifest-files"

const root = path.resolve(import.meta.dirname, "..")
const packageJson = readPackageJson(root)
const manifest = readApiManifest(root)

if (process.argv.includes("--generate")) {
  const entrypoints = Object.fromEntries(Object.entries(packageJson.exports).map(([key]) => {
    const name = key === "." ? packageJson.name : `${packageJson.name}${key.slice(1)}`
    const description = manifest.entrypoints[name]
    if (!description) throw new Error(`No reviewed API description for ${name}`)
    return [name, description]
  }))
  if (process.argv.includes("--entrypoints-only")) {
    const updated = {
      ...JSON.parse(fs.readFileSync(path.join(root, "docs/api-manifest.json"), "utf8")),
      entrypoints,
      declarationHashes: Object.fromEntries(Object.keys(entrypoints).map((name) => [name, manifest.declarationHashes[name]])),
      valueExports: Object.fromEntries(Object.entries(manifest.valueExports).filter(([name]) => name in entrypoints)),
    }
    fs.writeFileSync(path.join(root, "docs/api-manifest.json"), `${JSON.stringify(updated, null, 2)}\n`)
    process.exit(0)
  }
  const hashes: unknown = JSON.parse(execFileSync("bun", ["scripts/verify-publish.ts", "--print-declaration-hashes"], {
    cwd: root,
    encoding: "utf8",
  }))
  if (!isRecord(hashes) || !Object.values(hashes).every((hash) => typeof hash === "string")) {
    throw new Error("verify-publish printed no map of declaration hashes")
  }
  const valueExports = Object.fromEntries(await Promise.all(Object.entries(manifest.valueExports)
    .filter(([name]) => name in entrypoints)
    .map(async ([name]) => {
      const key = name === packageJson.name ? "." : `.${name.slice(packageJson.name.length)}`
      const target = packageJson.exports[key]?.import
      if (!target) throw new Error(`No built entrypoint for ${name}`)
      const module: object = await import(pathToFileURL(path.join(root, target)).href)
      return [name, Object.keys(module).sort()] as const
    })))
  const updated = {
    ...JSON.parse(fs.readFileSync(path.join(root, "docs/api-manifest.json"), "utf8")),
    entrypoints,
    declarationHashes: hashes,
    valueExports,
  }
  fs.writeFileSync(path.join(root, "docs/api-manifest.json"), `${JSON.stringify(updated, null, 2)}\n`)
  process.exit(0)
}

const exported = Object.keys(packageJson.exports)
  .map((key) => key === "." ? packageJson.name : `${packageJson.name}/${key.slice(2)}`)
  .sort()
const documented = Object.keys(manifest.entrypoints).sort()
const errors = [
  ...(manifest.package === packageJson.name ? [] : [`manifest package is ${manifest.package}; expected ${packageJson.name}`]),
  ...(manifest.version === packageJson.version ? [] : [`manifest version is ${manifest.version}; expected ${packageJson.version}`]),
  ...(JSON.stringify(exported) === JSON.stringify(documented)
    ? []
    : [`manifest entrypoints differ from package exports\nexports: ${exported.join(", ")}\ndocs: ${documented.join(", ")}`]),
]

if (errors.length > 0) throw new Error(errors.join("\n"))
