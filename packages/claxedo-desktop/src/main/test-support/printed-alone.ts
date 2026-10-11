import { spawnSync } from "node:child_process"

/**
 * What `script` prints when it runs in a fresh bun process, where the code it
 * calls is the only work the event loop has. An unreferenced timer there never
 * fires, as on Bun for Windows. The script must not use top-level await: bun
 * keeps a process alive while one is pending, which would hide that timer.
 */
export function printedAlone(script: string): string {
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 })
  if (result.error) throw result.error
  return result.stdout.trim()
}
