import fs from "fs"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  exports: Record<string, unknown>
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/api-manifest.json"), "utf8")) as {
  package: string
  version: string
  entrypoints: Record<string, unknown>
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
