import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CURSOR_WORKER_FILE } from "@claxedo/harness/compose"
import type { SpawnCommand } from "@claxedo/harness/contract"
import { loaderArgs } from "./loader-args"

export const CURSOR_WORKER_ENV = "CLAXEDO_CURSOR_WORKER"

function workerExists(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

function packagedWorker(): string {
  try { return fileURLToPath(import.meta.resolve("@claxedo/harness/cursor-worker")) }
  catch (cause) { throw new Error(`Cursor SDK worker not found. Set ${CURSOR_WORKER_ENV} to its path.`, { cause }) }
}

export function requireCursorWorker(env: NodeJS.ProcessEnv): Pick<SpawnCommand, "file" | "args"> {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), CURSOR_WORKER_FILE)
  const worker = env[CURSOR_WORKER_ENV] || (workerExists(bundled) ? bundled : packagedWorker())
  if (!workerExists(worker)) throw new Error(`Cursor SDK worker not found at ${worker}. Set ${CURSOR_WORKER_ENV} to its path.`)
  return { file: process.execPath, args: [...loaderArgs(worker), worker] }
}
