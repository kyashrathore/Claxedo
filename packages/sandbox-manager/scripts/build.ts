#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const entries = [
  "src/command.ts",
  "src/constants.ts",
  "src/daytona-allow-list.ts",
  "src/defaults.ts",
  "src/driver-catalog.ts",
  "src/drivers/cloudflare.ts",
  "src/drivers/cloudflare-egress.ts",
  "src/drivers/daytona.ts",
  "src/drivers/docker.ts",
  "src/drivers/fetch-bridge.ts",
  "src/drivers/modal.ts",
  "src/drivers/vercel.ts",
  "src/image.ts",
  "src/index.ts",
  "src/lease-policy.ts",
  "src/lease-types.ts",
  "src/runtime-env.ts",
  "src/runtime-version.ts",
  "src/service-url-exposure.ts",
  "src/stores/memory.ts",
]

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

execFileSync(path.join(ROOT, "node_modules/.bin/esbuild"), [
  ...entries,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--outdir=dist",
  "--outbase=src",
  "--out-extension:.js=.mjs",
  "--external:@claxedo/workspace-runtime",
  "--external:@daytona/sdk",
  "--external:@vercel/sandbox",
  "--external:modal",
], { stdio: "inherit", cwd: ROOT })
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { stdio: "inherit", cwd: ROOT })
