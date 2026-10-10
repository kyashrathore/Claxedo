import { execFileSync, spawnSync } from "node:child_process"
import { statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseSddl } from "./windows-private-file"

/**
 * What "owner-only" is asserted to mean on each platform, read back through a
 * different route than the one that set it: POSIX permission bits, or the
 * Windows descriptor in SDDL text rather than the .NET objects
 * `protectWindowsPath` checks.
 */

/**
 * `whoami /user`, so the expectation does not come from the descriptor being
 * tested, spelled as SDDL renders that SID: SYSTEM is `SY` and a built-in
 * Administrator `LA`, never their numeric form.
 */
export function currentWindowsSddlUser(): string {
  // By full path: on a runner with Git for Windows on PATH, a bare `whoami.exe`
  // is coreutils' `whoami`, which has no `/user`.
  const whoami = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")
  const line = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim()
  const sid = line.split(",").at(-1)?.replaceAll('"', "").trim()
  if (!sid?.startsWith("S-1-")) throw new Error(`whoami did not report a SID: ${line}`)
  const owner = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(New-Object System.Security.AccessControl.RawSecurityDescriptor ('O:' + $env:CLAXEDO_TEST_SID)).GetSddlForm('Owner')",
    ],
    { encoding: "utf8", env: { ...process.env, CLAXEDO_TEST_SID: sid } },
  ).trim()
  if (!owner.startsWith("O:")) throw new Error(`SDDL did not spell ${sid}: ${owner}`)
  return owner.slice("O:".length)
}

export function windowsSddl(path: string): string {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Acl -LiteralPath $env:CLAXEDO_TEST_PATH).GetSecurityDescriptorSddlForm('Access,Owner')",
    ],
    { encoding: "utf8", env: { ...process.env, CLAXEDO_TEST_PATH: path } },
  ).trim()
}

/**
 * A directory that hands full control to everyone, and hands it down: the
 * precondition every staging-file test needs, because a file that inherits
 * nothing proves nothing about a file that would have.
 */
export function inheritablyWidenWindowsDirectory(path: string): void {
  widenWindowsPath(path, "D:(A;OICI;FA;;;WD)(A;OICI;FA;;;BA)")
}

/** Replaces a path's permissions with ones any local account passes, standing in for a file that arrived permissive. */
export function widenWindowsPath(path: string, sddl = "D:(A;;FA;;;WD)(A;;FA;;;BA)"): void {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $acl = Get-Acl -LiteralPath $env:CLAXEDO_TEST_PATH; $acl.SetSecurityDescriptorSddlForm($env:CLAXEDO_TEST_SDDL); Set-Acl -LiteralPath $env:CLAXEDO_TEST_PATH -AclObject $acl",
    ],
    { encoding: "utf8", env: { ...process.env, CLAXEDO_TEST_PATH: path, CLAXEDO_TEST_SDDL: sddl } },
  )
}

export function describeSddl(sddl: string): string {
  const { owner, inheritanceBlocked, entries } = parseSddl(sddl)
  return `owner=${owner} inheritance-blocked=${inheritanceBlocked} entries=${entries.join("|")}`
}

export function ownerOnlyDescription(path: string): string {
  if (process.platform !== "win32") return `mode=${(statSync(path).mode & 0o777).toString(8)}`
  return describeSddl(windowsSddl(path))
}

export function expectedOwnerOnlyDescription(): string {
  if (process.platform !== "win32") return "mode=600"
  const user = currentWindowsSddlUser()
  return `owner=${user} inheritance-blocked=true entries=A;;FA;;;${user}`
}

/**
 * Runs `body` in a fresh Bun process with `name` imported from this package's
 * `module`, because the private-file runner is per process: only a new process
 * has none yet.
 */
export function inFreshProcess(dir: string, name: string, module: string, body: string[]) {
  const script = join(dir, "fresh.ts")
  const source = pathToFileURL(join(import.meta.dirname, module)).href
  writeFileSync(script, [`import { ${name} } from ${JSON.stringify(source)}`, ...body].join("\n"))
  return spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 120_000 })
}
