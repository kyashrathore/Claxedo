#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { copyIcons } from "./utils"

const copied = copyIcons()
console.log(`Copied ${copied.channel} icons from ${copied.src} to ${copied.dest}`)

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)
