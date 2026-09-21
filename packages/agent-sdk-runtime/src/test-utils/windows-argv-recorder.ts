import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isRecord } from "@claxedo/helpers/guards"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"

/**
 * Not `CLAXEDO_`-prefixed: `harnessSpawnEnv` drops every unlisted name under
 * that prefix before an ACP child sees its environment.
 */
export const ARGV_RECORD_ENV = "HARNESS_ARGV_RECORD"

export type ArgvRecord = { execPath: string; argv: string[] }

export type ArgvRecordingShim = {
  dir: string
  shim: string
  env: Record<string, string>
  read: () => ArgvRecord
  remove: () => void
}

const NPM_SHIM = (script: string) => [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
  "",
].join("\r\n")

const RECORD = `
const fs = require("node:fs")
fs.writeFileSync(process.env[${JSON.stringify(ARGV_RECORD_ENV)}], JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(2) }))
`

const SERVE = `
process.stdin.setEncoding("utf8")
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let boundary = buffer.indexOf("\\n"); boundary >= 0; boundary = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, boundary).trim()
    buffer = buffer.slice(boundary + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && message.method) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
  }
})
`

/**
 * `<name>.cmd` with the text npm writes for a global install, in a directory
 * whose path contains a space, wrapping a script that records its own
 * execPath and argv. With `serve` the script stays up answering every
 * JSON-RPC request with an empty result, which `CodexAppServerProcess.start`
 * needs before it resolves; without it the script exits once it has recorded.
 */
export function installArgvRecordingShim(name: string, options: { serve?: boolean } = {}): ArgvRecordingShim {
  const dir = mkdtempSync(path.join(tmpdir(), "acceptance shim-"))
  const script = `${name}-recorder.cjs`
  writeFileSync(path.join(dir, script), options.serve ? RECORD + SERVE : RECORD)
  const shim = path.join(dir, `${name}.cmd`)
  writeFileSync(shim, NPM_SHIM(script))
  const record = path.join(dir, "argv.json")
  return {
    dir,
    shim,
    env: { [ARGV_RECORD_ENV]: record },
    read: () => {
      const parsed: unknown = JSON.parse(readFileSync(record, "utf8"))
      if (!isRecord(parsed) || typeof parsed.execPath !== "string") throw new Error(`malformed argv record in ${record}`)
      const argv: unknown = parsed.argv
      if (!Array.isArray(argv) || !argv.every((item): item is string => typeof item === "string")) throw new Error(`malformed argv record in ${record}`)
      return { execPath: parsed.execPath, argv }
    },
    remove: () => removeTestTempDir(dir),
  }
}

/**
 * `<name>.cmd` whose only quoted target does not exist. A shell that ran it
 * would create `marker`, so the marker's absence after a refused launch is
 * native evidence that nothing was spawned.
 */
export function installUnresolvableShim(name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "acceptance shim-"))
  const shim = path.join(dir, `${name}.cmd`)
  writeFileSync(shim, `@echo off\r\necho ran> "%~dp0${name}-ran.txt"\r\n`)
  return { dir, shim, marker: path.join(dir, `${name}-ran.txt`), remove: () => removeTestTempDir(dir) }
}
