import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"

/**
 * What "owner-only" is asserted to mean on each platform, read back through a
 * different route than the one that set it: POSIX permission bits, or the
 * Windows descriptor in SDDL text rather than the .NET objects
 * `protectWindowsPath` checks.
 */

/** `whoami /user`, so the expectation does not come from the descriptor being tested. */
export function currentWindowsSid(): string {
  const line = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim()
  const sid = line.split(",").at(-1)?.replaceAll('"', "").trim()
  if (!sid?.startsWith("S-1-")) throw new Error(`whoami did not report a SID: ${line}`)
  return sid
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

/**
 * Owner, whether inheritance is blocked, and the entries themselves — read out
 * of the SDDL rather than compared as text. Windows renders the descriptor it
 * stored, not the one requested: a DACL set as `D:P` reads back as `D:PAI`,
 * and a string comparison would fail on a flag that changes nothing about who
 * can open the file.
 */
export function describeSddl(sddl: string): string {
  const parsed = /^O:(\S+?)D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl)
  if (!parsed) throw new Error(`no descriptor could be read from ${sddl}`)
  const entries = [...parsed[3]!.matchAll(/\(([^()]*)\)/g)].map((match) => match[1])
  return `owner=${parsed[1]} inheritance-blocked=${parsed[2]!.includes("P")} entries=${entries.join("|")}`
}

export function ownerOnlyDescription(path: string): string {
  if (process.platform !== "win32") return `mode=${(statSync(path).mode & 0o777).toString(8)}`
  return describeSddl(windowsSddl(path))
}

export function expectedOwnerOnlyDescription(): string {
  if (process.platform !== "win32") return "mode=600"
  const sid = currentWindowsSid()
  return `owner=${sid} inheritance-blocked=true entries=A;;FA;;;${sid}`
}
