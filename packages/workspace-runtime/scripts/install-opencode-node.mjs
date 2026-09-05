import fs from "node:fs"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const repo = path.resolve(packageRoot, "../..")
// In the source workspace, the root postinstall owns the whole dependency
// graph and runs after workspace lifecycle scripts. Published npm installs
// instead use the installer and patch data included by our build.
const sourceWorkspace = path.join(repo, "packages/workspace-runtime") === packageRoot
  && fs.existsSync(path.join(repo, "script/apply-dependency-patches.ts"))
if (sourceWorkspace) {
  console.log("OpenCode Node patches are owned by the workspace root postinstall")
} else {
  const { applyDependencyPatches } = await import("../dist/opencode-node/script/apply-dependency-patches.mjs")
  await applyDependencyPatches()
}
