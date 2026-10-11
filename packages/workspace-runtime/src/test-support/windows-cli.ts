import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export type CmdRun = { code: number | null; stdout: string; stderr: string }

/**
 * Runs `line` the way cmd.exe runs a typed command (`/d /s /c`) or a hook command line (`switches`
 * before `/c`). cmd.exe parses the line itself, so it goes over verbatim inside one pair of quotes.
 */
export function runInCmd(
  line: string,
  options: { env: Record<string, string>; cwd: string; stdin?: string; switches?: string[] },
): Promise<CmdRun> {
  const comspec = options.env.ComSpec ?? process.env.ComSpec ?? "cmd.exe"
  const child = spawn(comspec, [...(options.switches ?? ["/d", "/s"]), "/c", `"${line}"`], {
    env: options.env,
    cwd: options.cwd,
    windowsVerbatimArguments: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk))
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk))
  child.stdin.end(options.stdin ?? "")
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Writes `<dir>/<name>.cmd` as npm's cmd-shim writes it: it leaves its own batch context before starting
 * the runtime on `script` with `%*`. The script writes its arguments as JSON to `FAKE_ARGV` and exits
 * with `FAKE_EXIT`.
 */
export async function writeNpmShimRecorder(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true })
  const script = path.join(dir, `${name}-argv.mjs`)
  await fs.writeFile(
    script,
    'import { writeFileSync } from "node:fs"\n' +
      "writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)))\n" +
      "process.exit(Number(process.env.FAKE_EXIT ?? 0))\n",
  )
  await fs.writeFile(
    path.join(dir, `${name}.cmd`),
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      `SET "_prog=${process.execPath}"`,
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${script}" %*`,
      "",
    ].join("\r\n"),
  )
}
