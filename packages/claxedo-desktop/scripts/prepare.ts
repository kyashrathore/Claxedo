#!/usr/bin/env bun
import { $ } from "bun"

import { Script } from "@opencode-ai/script"
import { copyBinaryToSidecarFolder, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)

const sidecarConfig = getCurrentSidecar()

const dir = "resources/opencode-binaries"

await $`mkdir -p ${dir}`
await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n opencode-cli`.cwd(dir)

await copyBinaryToSidecarFolder(windowsify(`${dir}/${sidecarConfig.ocBinary}/bin/opencode`))

// Copy claxedo-mcp binary from artifact
const mcpDir = "resources/claxedo-mcp-binaries"
await $`mkdir -p ${mcpDir}`
await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n claxedo-mcp`.cwd(mcpDir)
const mcpDest = windowsify("resources/claxedo-mcp")
await $`cp ${mcpDir}/claxedo-mcp ${mcpDest}`
if (process.platform !== "win32") await $`chmod +x ${mcpDest}`
await $`rm -rf ${mcpDir}`

await $`rm -rf ${dir}`
