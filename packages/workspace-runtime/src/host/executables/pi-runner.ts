import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PI_RUNNER_FILE } from "@claxedo/harness/compose"
import type { SpawnCommand } from "@claxedo/harness/contract"
import { loaderArgs } from "./loader-args"

export const PI_RUNNER_ENV = "CLAXEDO_PI_RUNNER"

function runnerExists(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

function packagedRunner(): string {
  try { return fileURLToPath(import.meta.resolve("@claxedo/harness/pi-runner")) }
  catch (cause) { throw new Error(`Pi shell host not found. Set ${PI_RUNNER_ENV} to its path.`, { cause }) }
}

export function requirePiRunner(env: NodeJS.ProcessEnv): Pick<SpawnCommand, "file" | "args"> {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), PI_RUNNER_FILE)
  const runner = env[PI_RUNNER_ENV] || (runnerExists(bundled) ? bundled : packagedRunner())
  if (!runnerExists(runner)) throw new Error(`Pi shell host not found at ${runner}. Set ${PI_RUNNER_ENV} to its path.`)
  return { file: process.execPath, args: [...loaderArgs(runner), runner] }
}
