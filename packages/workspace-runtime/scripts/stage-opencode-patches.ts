import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { build } from "esbuild"

/** Package the canonical installer and exact SDK patches for Node-only installs. */
export async function stageOpenCodePatches(output: string) {
  const repo = path.resolve(import.meta.dirname, "../../..")
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
  const patches = Object.fromEntries(
    Object.entries(manifest.claxedoDependencyPatches as Record<string, string>)
      .filter(([name]) => name.startsWith("@opencode-ai/")),
  )
  const digest = createHash("sha256")
  for (const file of Object.values(patches)) {
    const contents = fs.readFileSync(path.join(repo, file))
    fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true })
    fs.writeFileSync(path.join(output, file), contents)
    digest.update(file).update(contents)
  }
  const installer = "script/apply-dependency-patches.mjs"
  await build({
    entryPoints: [path.join(repo, "script/apply-dependency-patches.ts")],
    outfile: path.join(output, installer),
    platform: "node", format: "esm", bundle: true,
  })
  digest.update(fs.readFileSync(path.join(output, installer)))
  return { patches, installer, digest: digest.digest("hex") }
}
