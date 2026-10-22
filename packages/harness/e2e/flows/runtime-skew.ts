import { spawnSync } from "node:child_process"
import path from "node:path"
import { SERVED_WORKSPACE_RUNTIME_FLOOR } from "@claxedo/sandbox-manager/image"

/**
 * The current control plane and relay against the oldest runtime image they
 * serve: the cloud flows run with every sandbox booted from that published
 * image instead of this tree's runtime. A wire change the floor's runtime
 * cannot speak fails here; the fix is to raise the floor, and the runtime
 * version with it, in the same commit.
 */
const FLOWS = ["H19-cloud-turn", "H19.hostedacp", "H19.hostedopencode", "H19.hostedpi", "H19.pi", "H31", "H39"]

const root = path.resolve(import.meta.dirname, "../..")
const image = process.argv.find((arg) => arg.startsWith("--image="))?.slice("--image=".length) ?? SERVED_WORKSPACE_RUNTIME_FLOOR.image

function step(label: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  console.log(`\n=== ${label}`)
  const status = spawnSync(command, args, { cwd: root, env, stdio: "inherit" }).status
  if (status !== 0) {
    console.error(`${label} failed (exit ${status})`)
    process.exit(status ?? 1)
  }
}

step(`the floor image ${image} is published`, "docker", ["buildx", "imagetools", "inspect", image])
step("pull the floor image", "docker", ["pull", "--platform", "linux/amd64", "--quiet", image])
step(`cloud flows against ${image}`, process.execPath, ["e2e/flows/run.ts", ...FLOWS], { ...process.env, CLAXEDO_E2E_RUNTIME_IMAGE: image })
