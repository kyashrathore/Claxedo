#!/usr/bin/env bun

import * as path from "node:path"

import { write, verify } from "./contract"
import { requireLocalServerBundle } from "./local-server"
import { clearDesktopBoundaryManifests, verifyDesktopBoundaryManifestSet } from "./product-boundary-manifests"
import { copyWorkspaceRuntimeTemplates } from "./utils"

const root = path.resolve(import.meta.dir, "..")

// The local-server bundle is `prebuild`'s output and this build's input. The
// vite plugin that copies it into `out/main/` skips silently when it is absent,
// which produced an app whose server was simply missing; the contract then
// failed with a bare "missing path". Fail here instead, naming the artifact and
// the command that produces it. Nothing is started in its place.
console.log(`[build] local server bundle at ${requireLocalServerBundle(root)}`)
clearDesktopBoundaryManifests(root)

const proc = Bun.spawn({
  cmd: ["bun", "run", "build:inner"],
  cwd: root,
  env: Bun.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

if (await proc.exited !== 0) {
  process.exit(1)
}

const copied = copyWorkspaceRuntimeTemplates(path.join(root, "out/templates"))
console.log(`[build] copied workspace-runtime templates from ${copied.src} to ${copied.dest}`)

const boundaryManifests = verifyDesktopBoundaryManifestSet(root)
console.log(`[build] product boundary manifests: ${boundaryManifests.join(", ")}`)

write()
const saved = verify()
console.log(`[build] contract locked at ${saved.built_at}`)
