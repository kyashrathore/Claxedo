import { rm } from "node:fs/promises"
import path from "node:path"
import { build } from "esbuild"
import manifest from "../package.json"

const root = path.resolve(import.meta.dirname, "..")
await rm(path.join(root, "dist"), { recursive: true, force: true })
const entryPoints = Object.values(manifest.exports).map((entry) => path.join(root, entry.bun))
await build({
  entryPoints,
  outbase: path.join(root, "src"),
  outdir: path.join(root, "dist"),
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  bundle: true,
  splitting: true,
})
const declarations = Bun.spawn(["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (await declarations.exited !== 0) throw new Error("Harness declarations failed")
