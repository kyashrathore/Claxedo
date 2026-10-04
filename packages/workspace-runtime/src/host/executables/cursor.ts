import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CURSOR_WORKER_FILE } from "@claxedo/harness/compose"
import type { SpawnCommand } from "@claxedo/harness/contract"

export const CURSOR_WORKER_ENV = "CLAXEDO_CURSOR_WORKER"

const LOADER_FLAG = /^--(import|loader|experimental-loader|conditions|experimental-[\w-]+)(=|$)/

function workerExists(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

function packagedWorker(): string {
  try { return fileURLToPath(import.meta.resolve("@claxedo/harness/cursor-worker")) }
  catch (cause) { throw new Error(`Cursor SDK worker not found. Set ${CURSOR_WORKER_ENV} to its path.`, { cause }) }
}

function loaderArgs(worker: string): string[] {
  if (!worker.endsWith(".ts") || process.versions.bun) return []
  const args: string[] = []
  for (let index = 0; index < process.execArgv.length; index++) {
    const flag = process.execArgv[index]
    if (flag === undefined || !LOADER_FLAG.test(flag)) continue
    args.push(flag)
    const value = process.execArgv[index + 1]
    if (flag.includes("=") || value === undefined || value.startsWith("-")) continue
    args.push(value)
    index++
  }
  return args
}

export function requireCursorWorker(env: NodeJS.ProcessEnv): Pick<SpawnCommand, "file" | "args"> {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), CURSOR_WORKER_FILE)
  const worker = env[CURSOR_WORKER_ENV] || (workerExists(bundled) ? bundled : packagedWorker())
  if (!workerExists(worker)) throw new Error(`Cursor SDK worker not found at ${worker}. Set ${CURSOR_WORKER_ENV} to its path.`)
  return { file: process.execPath, args: [...loaderArgs(worker), worker] }
}
