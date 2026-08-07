import { existsSync, mkdirSync, statSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveTargetOsArch } from "./target-platform"

export async function buildMemoryImpactHelper() {
  if (process.platform !== "darwin") return
  const source = resolve(import.meta.dirname, "../resources/diagnostics/macos-memory-impact.c")
  const output = resolve(import.meta.dirname, "../resources/diagnostics/macos-memory-impact")
  const arch = resolveTargetOsArch().endsWith("-x64") ? "x86_64" : "arm64"
  const currentArch = existsSync(output)
    ? new TextDecoder().decode(Bun.spawnSync({ cmd: ["/usr/bin/lipo", "-archs", output], stdout: "pipe" }).stdout).trim()
    : undefined
  if (currentArch === arch && statSync(output).mtimeMs >= statSync(source).mtimeMs) return
  mkdirSync(dirname(output), { recursive: true })
  const result = Bun.spawnSync({
    cmd: [
      "/usr/bin/xcrun",
      "clang",
      "-arch",
      arch,
      "-Os",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      output,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`macOS memory impact helper failed to build: ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  await chmod(output, 0o755)
}

if (import.meta.main) await buildMemoryImpactHelper()
