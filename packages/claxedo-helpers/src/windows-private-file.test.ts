import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  describeSddl,
  expectedOwnerOnlyDescription,
  inheritablyWidenWindowsDirectory,
  ownerOnlyDescription,
  widenWindowsPath,
} from "./private-file.test-support"
import { PrivateFileError, writeWindowsPrivateFile } from "./windows-private-file"

/**
 * The native half of the private-file contract. Nothing here can be proved on
 * another platform, so `focus-helpers-windows` sets
 * `CLAXEDO_WINDOWS_ACL_ACCEPTANCE` to make the run assert rather than skip.
 *
 * Every adversary below runs at the barrier `beforeWrite` opens — the staging
 * file exists, its descriptor is verified, and no secret byte has been written.
 * That is the exact moment an attacker would have to win, so the tests occupy
 * it rather than racing it, and none of them depend on timing.
 */

const demanded = process.env.CLAXEDO_WINDOWS_ACL_ACCEPTANCE === "1"
const SECRET = '{"accessToken":"tok_do_not_share"}'
const bytes = (value: string) => new TextEncoder().encode(value)
/** Reachable by a service account, which neither this run's temporary directory nor a profile is. */
const PUBLIC = "C:\\Users\\Public"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claxedo-private-file-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function staging() {
  return join(dir, ".credentials.json.staging.tmp")
}

function target() {
  return join(dir, "credentials.json")
}

/** Runs one PowerShell expression against a path and reports how it ended, without interpreting it. */
function attempt(expression: string, variables: Record<string, string>) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; try { ${expression}; 'ALLOWED' } catch { 'REFUSED:' + $_.Exception.GetType().Name + ':' + $_.Exception.Message }`,
    ],
    { encoding: "utf8", env: { ...process.env, ...variables } },
  )
  return (result.stdout ?? "").trim()
}

function openAttempt(path: string, access: "Read" | "Write" | "ReadWrite") {
  return attempt(
    `$h = [System.IO.File]::Open($env:CLAXEDO_TEST_PATH, 'Open', '${access}', 'None'); $h.Close()`,
    { CLAXEDO_TEST_PATH: path },
  )
}

function renameAttempt(from: string, to: string) {
  return attempt("[System.IO.File]::Move($env:CLAXEDO_TEST_FROM, $env:CLAXEDO_TEST_TO)", {
    CLAXEDO_TEST_FROM: from,
    CLAXEDO_TEST_TO: to,
  })
}

function createAttempt(path: string) {
  return attempt(
    "$h = [System.IO.File]::Open($env:CLAXEDO_TEST_PATH, 'CreateNew', 'Write', 'None'); $h.Close()",
    { CLAXEDO_TEST_PATH: path },
  )
}

describe.skipIf(process.platform !== "win32")("a private file on Windows", () => {
  test("is owner-only at birth, before any byte is written", async () => {
    inheritablyWidenWindowsDirectory(dir)
    let atBirth: string | undefined

    await writeWindowsPrivateFile({
      target: target(),
      staging: staging(),
      contents: bytes(SECRET),
      // Read from the handle the runner holds, not from the name: the staging
      // file is already marked for deletion here, so opening it by name is
      // refused — which is itself the arming being in place this early.
      beforeWrite: ({ sddl }) => {
        atBirth = describeSddl(sddl)
      },
    })

    // The parent grants everyone full control inheritably, so anything the file
    // inherited would show up here.
    expect(atBirth).toBe(expectedOwnerOnlyDescription())
    expect(readFileSync(target(), "utf8")).toBe(SECRET)
  }, 30_000)

  test("cannot be opened by anyone else in the moment before the secret is written", async () => {
    inheritablyWidenWindowsDirectory(dir)
    const attempts: Record<string, string> = {}

    await writeWindowsPrivateFile({
      target: target(),
      staging: staging(),
      contents: bytes(SECRET),
      beforeWrite: () => {
        attempts.read = openAttempt(staging(), "Read")
        attempts.write = openAttempt(staging(), "Write")
      },
    })

    // A handle opened here would keep its access after any later narrowing,
    // which is the whole reason the descriptor cannot be applied afterwards.
    expect(attempts.read).toStartWith("REFUSED:")
    expect(attempts.write).toStartWith("REFUSED:")
    expect(readFileSync(target(), "utf8")).toBe(SECRET)
  })

  test("cannot have its staging name moved aside or taken over", async () => {
    inheritablyWidenWindowsDirectory(dir)
    const decoy = join(dir, "decoy.tmp")
    const attempts: Record<string, string> = {}

    await writeWindowsPrivateFile({
      target: target(),
      staging: staging(),
      contents: bytes(SECRET),
      beforeWrite: () => {
        attempts.rename = renameAttempt(staging(), decoy)
        attempts.create = createAttempt(staging())
      },
    })

    expect(attempts.rename).toStartWith("REFUSED:")
    expect(attempts.create).toStartWith("REFUSED:")
    expect(existsSync(decoy)).toBe(false)
    expect(readFileSync(target(), "utf8")).toBe(SECRET)
    expect(ownerOnlyDescription(target())).toBe(expectedOwnerOnlyDescription())
    expect(readdirSync(dir)).toEqual(["credentials.json"])
  })

  test("replaces a target that already existed readable by anyone", async () => {
    const existing = target()
    writeFileSync(existing, "{}")
    widenWindowsPath(existing, "D:(A;;FA;;;WD)(A;;FA;;;BA)")

    await writeWindowsPrivateFile({ target: existing, staging: staging(), contents: bytes(SECRET) })

    expect(readFileSync(existing, "utf8")).toBe(SECRET)
    expect(ownerOnlyDescription(existing)).toBe(expectedOwnerOnlyDescription())
  })

  test("refuses a staging name that is already a reparse point", async () => {
    // A junction needs no privilege, unlike a symbolic link, so it is the
    // redirection an unprivileged attacker actually has.
    const elsewhere = join(dir, "elsewhere")
    execFileSync("cmd.exe", ["/c", "mkdir", elsewhere], { encoding: "utf8" })
    const link = join(dir, "link.tmp")
    execFileSync("cmd.exe", ["/c", "mklink", "/J", link, elsewhere], { encoding: "utf8" })

    const error = await writeWindowsPrivateFile({
      target: target(),
      staging: link,
      contents: bytes(SECRET),
    }).catch((thrown: unknown) => thrown)

    // The reason matters, not just the refusal: a broken runner refuses
    // everything, and would otherwise read as this property holding.
    expect(error).toBeInstanceOf(PrivateFileError)
    expect(String(error)).toContain("staging file could not be created")
    expect(readdirSync(elsewhere)).toEqual([])
    expect(existsSync(target())).toBe(false)
  })

  test("a callback that throws synchronously cancels the write and deletes the staging file", async () => {
    const failure = new Error("the caller refused to continue")

    await expect(
      writeWindowsPrivateFile({
        target: target(),
        staging: staging(),
        contents: bytes(SECRET),
        beforeWrite: () => {
          throw failure
        },
      }),
    ).rejects.toThrow(failure)

    // Neither an empty file published as though it were the secret, nor a
    // staging file left behind holding one. A synchronous throw is the case
    // that used to escape the event handler entirely.
    expect(existsSync(target())).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)

  test("a callback that rejects asynchronously cancels the same way", async () => {
    const failure = new Error("the caller changed its mind")

    await expect(
      writeWindowsPrivateFile({
        target: target(),
        staging: staging(),
        contents: bytes(SECRET),
        beforeWrite: async () => {
          await new Promise((settle) => setTimeout(settle, 10))
          throw failure
        },
      }),
    ).rejects.toThrow(failure)

    expect(existsSync(target())).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)

  test("killing the holder at the barrier still takes the staging file with it", async () => {
    // The cleanup claim that matters, and the one a `finally` cannot make:
    // TerminateProcess runs no more managed code, so the file survives only if
    // its deletion was already armed on the handle before the caller was told
    // the file existed.
    await expect(
      writeWindowsPrivateFile({
        target: target(),
        staging: staging(),
        contents: bytes(SECRET),
        beforeWrite: ({ holder }) => {
          // A delete-pending file still has a directory entry until its last
          // handle closes, so the listing is what tells "armed" from "gone".
          // `existsSync` cannot: opening the name is already refused.
          expect(readdirSync(dir)).toHaveLength(1)
          execFileSync("taskkill.exe", ["/PID", String(holder), "/F"], { encoding: "utf8" })
        },
      }),
    ).rejects.toThrow(PrivateFileError)

    expect(existsSync(staging())).toBe(false)
    expect(existsSync(target())).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)

  test("a staging name that is already taken fails closed", async () => {
    const taken = staging()
    writeFileSync(taken, "someone got here first")

    const error = await writeWindowsPrivateFile({
      target: target(),
      staging: taken,
      contents: bytes(SECRET),
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(PrivateFileError)
    expect(String(error)).toContain("staging file could not be created")
    expect(readFileSync(taken, "utf8")).toBe("someone got here first")
    expect(existsSync(target())).toBe(false)
  })

  test("a missing interpreter fails closed and says nothing about the contents", async () => {
    const systemRoot = process.env.SystemRoot
    process.env.SystemRoot = join(dir, "no-interpreter-here")
    try {
      const error = await writeWindowsPrivateFile({
        target: target(),
        staging: staging(),
        contents: bytes(SECRET),
      }).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(PrivateFileError)
      expect(String(error)).toContain(target())
      // Runtimes word a missing executable differently — Node raises ENOENT,
      // Bun says "Executable not found in $PATH" — so the assertion is on this
      // module's own cause, which is the same under both.
      expect(String(error)).toContain("the interpreter could not be started")
      expect(String(error)).not.toContain("tok_do_not_share")
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = systemRoot
    }
    expect(existsSync(target())).toBe(false)
  })
})

/**
 * `NT AUTHORITY\LOCAL SERVICE`: a principal that always exists, needs no
 * password, and is named by none of the entries a private file carries. A
 * scheduled task is how it gets to run — a secondary logon would need an
 * account, a password policy and a first-logon profile, none of which this is
 * about.
 */
const UNRELATED_ACCOUNT = "NT AUTHORITY\\LOCAL SERVICE"

function isAdministrator() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { encoding: "utf8" },
  )
  return result.stdout?.trim() === "True"
}

/** A minute ahead, so `schtasks` arms the task rather than warning that its start time has passed. */
function startTime() {
  const at = new Date(Date.now() + 60_000)
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
}

/** Reads `path` as that account and returns what it saw, or throws with why it could not be asked. */
function readAsUnrelatedAccount(path: string) {
  const name = `claxedo-acl-${process.pid}-${Date.now()}`
  const answer = join(PUBLIC, `${name}.txt`)
  const runner = join(PUBLIC, `${name}.ps1`)
  writeFileSync(
    runner,
    [
      "param([string]$Target, [string]$Answer)",
      // Without this, an access-denied read is NON-terminating: the catch never
      // runs, nothing is written, and the refusal reads as a hang.
      "$ErrorActionPreference = 'Stop'",
      "try { Get-Content -LiteralPath $Target -Raw | Set-Content -LiteralPath $Answer -NoNewline }",
      'catch { Set-Content -LiteralPath $Answer -Value ("DENIED:" + $_.Exception.GetType().Name) -NoNewline }',
    ].join("\r\n"),
  )
  writeFileSync(answer, "")
  widenWindowsPath(runner, "D:(A;;FA;;;WD)(A;;FA;;;BA)")
  widenWindowsPath(answer, "D:(A;;FA;;;WD)(A;;FA;;;BA)")
  const command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${runner}" "${path}" "${answer}"`
  try {
    execFileSync(
      "schtasks.exe",
      ["/create", "/tn", name, "/tr", command, "/sc", "once", "/st", startTime(), "/ru", UNRELATED_ACCOUNT, "/rl", "LIMITED", "/f"],
      { encoding: "utf8" },
    )
    execFileSync("schtasks.exe", ["/run", "/tn", name], { encoding: "utf8" })
    const deadline = Date.now() + 60_000
    for (;;) {
      const said = readFileSync(answer, "utf8").trim()
      if (said) return said
      if (Date.now() >= deadline) {
        const query = spawnSync("schtasks.exe", ["/query", "/tn", name, "/fo", "list", "/v"], { encoding: "utf8" })
        throw new Error(`${UNRELATED_ACCOUNT} never answered for ${path}; task state: ${query.stdout?.trim()}`)
      }
      Bun.sleepSync(250)
    }
  } finally {
    spawnSync("schtasks.exe", ["/delete", "/tn", name, "/f"], { encoding: "utf8" })
    rmSync(answer, { force: true })
    rmSync(runner, { force: true })
  }
}

describe.skipIf(process.platform !== "win32")("a private file and an unrelated account", () => {
  test("the account can read a permissive file and is refused this one", async () => {
    if (!isAdministrator()) {
      // Running a task as another principal needs administrator. Reporting the
      // gap is the point: a silent skip would read as a passing denial proof.
      const detail = `this host cannot run a task as ${UNRELATED_ACCOUNT}, so the denial is unproven`
      if (demanded) throw new Error(`CLAXEDO_WINDOWS_ACL_ACCEPTANCE demanded the unrelated-account proof but ${detail}`)
      console.warn(`skipping the unrelated-account proof: ${detail}`)
      return
    }

    // Both files sit under a parent that account can reach, which is the
    // situation the protection exists for: a permissive parent, and the file
    // carrying its own.
    const readable = join(PUBLIC, `claxedo-acl-readable-${process.pid}.json`)
    const guarded = join(PUBLIC, `claxedo-acl-guarded-${process.pid}.json`)
    try {
      // The control. Without it, a denial below would show only that the
      // account cannot reach this path at all, not that the descriptor did it.
      writeFileSync(readable, SECRET)
      widenWindowsPath(readable, "D:(A;;FA;;;WD)(A;;FA;;;BA)")
      expect(readAsUnrelatedAccount(readable)).toBe(SECRET)

      await writeWindowsPrivateFile({
        target: guarded,
        staging: join(PUBLIC, `claxedo-acl-guarded-${process.pid}.tmp`),
        contents: bytes(SECRET),
      })

      const answer = readAsUnrelatedAccount(guarded)
      expect(answer).toStartWith("DENIED:")
      expect(answer).not.toContain("tok_do_not_share")
    } finally {
      rmSync(readable, { force: true })
      rmSync(guarded, { force: true })
    }
  }, 180_000)
})
