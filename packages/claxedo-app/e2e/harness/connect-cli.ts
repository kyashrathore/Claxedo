import { spawn } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { REPO_ROOT, TSX_LOADER } from "../../../harness/e2e/harness/node-loader"
import type { SignedStack } from "./signed-stack"

const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/src/index.ts")
const LOCALHOST_RESOLVER = pathToFileURL(path.join(REPO_ROOT, "packages/harness/e2e/harness/localhost-resolver.mjs")).href
const TEXT_IMPORTS = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href

export type ConnectCli = {
  readonly folder: string
  readonly lines: () => readonly string[]
  readonly exited: Promise<number | null>
  readonly stop: () => Promise<number | null>
}

export async function connectFolder(name: string): Promise<{ home: string; folder: string; close: () => Promise<void> }> {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "claxedo-connect-e2e-")))
  const folder = path.join(home, name)
  await mkdir(folder)
  return { home, folder, close: () => rm(home, { recursive: true, force: true }) }
}

export function startConnectCli(signed: SignedStack, input: { readonly code: string; readonly home: string; readonly folder: string }): ConnectCli {
  const output: string[] = []
  const child = spawn(process.execPath, ["--conditions=development", "--import", TEXT_IMPORTS, "--import", LOCALHOST_RESOLVER, "--import", TSX_LOADER, CLI_ENTRY, "connect", "--pair", input.code], {
    cwd: input.folder,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: input.home,
      CLAXEDO_HOME: path.join(input.home, ".claxedo"),
      CLAXEDO_CONTROL_PLANE_URL: signed.url,
      NODE_EXTRA_CA_CERTS: signed.hosted.certificate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let pending = ""
  const collect = (chunk: Buffer) => {
    pending += chunk.toString("utf8")
    const parts = pending.split("\n")
    pending = parts.pop() ?? ""
    output.push(...parts)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  return {
    folder: input.folder,
    lines: () => [...output, ...(pending ? [pending] : [])],
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM")
      return await exited
    },
  }
}
