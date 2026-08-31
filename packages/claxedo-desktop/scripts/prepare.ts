#!/usr/bin/env bun

import path from "node:path"
import { copyIcons } from "./utils"

const copied = copyIcons()
console.log(`Copied ${copied.channel} icons from ${copied.src} to ${copied.dest}`)

const pkg = await Bun.file("./package.json").json()
const rootPkg = await Bun.file(path.resolve(import.meta.dir, "../../../package.json")).json()
const version = process.env.CLAXEDO_VERSION?.trim() || rootPkg.version || pkg.version
pkg.version = version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${version}`)
