import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const binary = path.join(packageRoot, "node_modules/@openai/codex/bin/codex.js")
const output = path.join(packageRoot, "src/transports/codex-app-server/translate/protocol")
const artifacts = path.join(packageRoot, ".artifacts")

export class CodexProtocolGeneratorMissingError extends Error {
  constructor(binaryPath: string) {
    super(`Pinned Codex generator is missing at ${binaryPath}. Run bun install before generating the protocol.`)
    this.name = "CodexProtocolGeneratorMissingError"
  }
}

function sameFiles(left: string, right: string): boolean {
  if (!existsSync(left)) return false
  const leftEntries = readdirSync(left, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const rightEntries = readdirSync(right, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every((entry, index) => {
    const other = rightEntries[index]
    if (!other || entry.name !== other.name || entry.isDirectory() !== other.isDirectory()) return false
    const leftPath = path.join(left, entry.name)
    const rightPath = path.join(right, other.name)
    return entry.isDirectory() ? sameFiles(leftPath, rightPath) : readFileSync(leftPath).equals(readFileSync(rightPath))
  })
}

if (!existsSync(binary)) throw new CodexProtocolGeneratorMissingError(binary)

mkdirSync(artifacts, { recursive: true })
const generated = mkdtempSync(path.join(artifacts, "codex-protocol-"))
try {
  const result = spawnSync(process.execPath, [binary, "app-server", "generate-ts", "--out", generated], {
    cwd: packageRoot,
    stdio: "inherit",
  })
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new CodexProtocolGeneratorMissingError(binary)
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Codex protocol generation failed (${result.signal ?? `exit ${result.status}`})`)
  }
  if (!sameFiles(output, generated)) {
    rmSync(output, { recursive: true, force: true })
    renameSync(generated, output)
  }
} finally {
  rmSync(generated, { recursive: true, force: true })
}
