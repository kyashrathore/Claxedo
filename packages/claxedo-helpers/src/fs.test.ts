import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrivateFileError, readJsonFile, resolvePem, writeFileAtomic, writeFileAtomicSync, writePrivateFileAtomic } from "./fs"
import { expectedOwnerOnlyDescription, ownerOnlyDescription, widenWindowsPath, windowsSddl } from "./private-file.test-support"

let dir: string

const onPosix = process.platform !== "win32"
const onWindows = process.platform === "win32"
/** The native lane promises these properties are checked, so an unmet precondition there is a failure, not a skip. */
const demandedOnWindows = onWindows && process.env.CLAXEDO_WINDOWS_ACL_ACCEPTANCE === "1"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claxedo-helpers-fs-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A symlink needs a privilege on Windows that a lane may not hold; skipping it there would hide the POSIX regression. */
function canSymlink() {
  const probe = join(dir, ".symlink-probe")
  try {
    symlinkSync(join(dir, "nothing"), probe, "file")
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

describe("writeFileAtomic", () => {
  test("writes the contents and leaves no temp file behind", async () => {
    const file = join(dir, "state.json")
    await writeFileAtomic(file, '{"a":1}')
    expect(readFileSync(file, "utf8")).toBe('{"a":1}')
    expect(readdirSync(dir)).toEqual(["state.json"])
  })

  test("overwrites an existing file", async () => {
    const file = join(dir, "state.json")
    writeFileSync(file, "old")
    await writeFileAtomic(file, "new")
    expect(readFileSync(file, "utf8")).toBe("new")
  })

  test.skipIf(onWindows)("defaults to POSIX 0600", async () => {
    const file = join(dir, "secret")
    await writeFileAtomic(file, "s")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test.skipIf(onWindows)("an explicit mode is honoured", async () => {
    const file = join(dir, "public")
    await writeFileAtomic(file, "s", { mode: 0o644 })
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  test.skipIf(onPosix)("a POSIX mode reaches Windows only as the read-only attribute", async () => {
    // Not an accident to paper over: `mode` has no DACL meaning here, and a
    // caller that needs one has to say so through writePrivateFileAtomic.
    const file = join(dir, "public")
    await writeFileAtomic(file, "s", { mode: 0o644 })
    expect(statSync(file).mode & 0o777).toBe(0o666)
    const readOnly = join(dir, "read-only")
    await writeFileAtomic(readOnly, "s", { mode: 0o444 })
    expect(statSync(readOnly).mode & 0o777).toBe(0o444)
  })

  test("accepts bytes as well as text", async () => {
    const file = join(dir, "bytes.bin")
    await writeFileAtomic(file, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(file)]).toEqual([1, 2, 3])
  })

  test("a missing directory fails unless mkdir is requested", async () => {
    const nested = join(dir, "a", "b", "state.json")
    await expect(writeFileAtomic(nested, "x")).rejects.toThrow()
    await writeFileAtomic(nested, "x", { mkdir: true })
    expect(readFileSync(nested, "utf8")).toBe("x")
  })

  test("a failure after the staging file is created removes it", async () => {
    const blocked = join(dir, "occupied")
    mkdirSync(blocked)
    await expect(writeFileAtomic(blocked, "x")).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(["occupied"])
  })
})

describe("writeFileAtomicSync", () => {
  test("same result, synchronously", () => {
    const file = join(dir, "state.json")
    writeFileAtomicSync(file, "sync")
    expect(readFileSync(file, "utf8")).toBe("sync")
    expect(readdirSync(dir)).toEqual(["state.json"])
  })

  test.skipIf(onWindows)("defaults to POSIX 0600", () => {
    const file = join(dir, "state.json")
    writeFileAtomicSync(file, "sync")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("mkdir creates the parents", () => {
    const nested = join(dir, "a", "b", "state.json")
    writeFileAtomicSync(nested, "x", { mkdir: true })
    expect(readFileSync(nested, "utf8")).toBe("x")
  })

  test("a failure after the staging file is created removes it", () => {
    const blocked = join(dir, "occupied")
    mkdirSync(blocked)
    expect(() => writeFileAtomicSync(blocked, "x")).toThrow()
    expect(readdirSync(dir)).toEqual(["occupied"])
  })
})

describe("writePrivateFileAtomic", () => {
  const secret = '{"accessToken":"tok_do_not_share"}'

  test("the file it creates is readable only by its owner", async () => {
    const file = join(dir, "credentials.json")
    await writePrivateFileAtomic(file, secret)
    expect(readFileSync(file, "utf8")).toBe(secret)
    expect(ownerOnlyDescription(file)).toBe(expectedOwnerOnlyDescription())
  })

  test("a directory it creates is 0700 on POSIX, and the file carries the protection on both", async () => {
    const file = join(dir, "state", "credentials.json")
    await writePrivateFileAtomic(file, secret, { mkdir: true })
    expect(ownerOnlyDescription(file)).toBe(expectedOwnerOnlyDescription())
    if (onPosix) expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700)
  })

  test("a target that already existed permissively ends up owner-only", async () => {
    const file = join(dir, "credentials.json")
    writeFileSync(file, "{}", { mode: 0o644 })
    if (onWindows) widenWindowsPath(file)

    await writePrivateFileAtomic(file, secret)

    expect(readFileSync(file, "utf8")).toBe(secret)
    expect(ownerOnlyDescription(file)).toBe(expectedOwnerOnlyDescription())
  })

  test("an existing parent keeps the permissions the caller gave it", async () => {
    // $CLAXEDO_HOME may legitimately be a shared or group-readable directory.
    // The secret is protected by its own permissions, never by rewriting the
    // caller's.
    const parent = join(dir, "shared")
    mkdirSync(parent, { mode: 0o755 })
    const before = onWindows ? windowsSddl(parent) : statSync(parent).mode & 0o777
    if (onWindows) {
      widenWindowsPath(parent, "D:(A;OICI;FA;;;WD)(A;OICI;FA;;;BA)")
    }
    const widened = onWindows ? windowsSddl(parent) : before

    await writePrivateFileAtomic(join(parent, "credentials.json"), secret, { mkdir: true })

    expect(onWindows ? windowsSddl(parent) : statSync(parent).mode & 0o777).toEqual(widened)
    expect(ownerOnlyDescription(join(parent, "credentials.json"))).toBe(expectedOwnerOnlyDescription())
  })

  test("a symlink at the target is replaced, not written through", async () => {
    if (!canSymlink()) {
      // Creating one needs a privilege this host does not hold. Saying so is
      // the point; reporting a pass would claim a property nothing checked.
      if (demandedOnWindows) throw new Error("this host cannot create a symbolic link, so the property is unproven")
      return
    }
    const outside = join(dir, "outside.txt")
    writeFileSync(outside, "untouched")
    const file = join(dir, "credentials.json")
    symlinkSync(outside, file, "file")

    await writePrivateFileAtomic(file, secret)

    expect(readFileSync(outside, "utf8")).toBe("untouched")
    // `statSync` follows the link and could never report one; only `lstatSync`
    // can tell a replaced link from a link written through.
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
    expect(readFileSync(file, "utf8")).toBe(secret)
    expect(ownerOnlyDescription(file)).toBe(expectedOwnerOnlyDescription())
  })

  test("a concurrent reader only ever sees a complete version", async () => {
    // Deliberately few rounds: a private write on Windows spawns an
    // interpreter and compiles its runner, so this costs seconds per round
    // there, and the property is about each replacement rather than about volume.
    const rounds = onWindows ? 3 : 20
    const file = join(dir, "credentials.json")
    await writePrivateFileAtomic(file, '{"v":0}')

    const loop = { reading: true }
    const reader = (async () => {
      while (loop.reading) {
        expect(readFileSync(file, "utf8")).toMatch(/^\{"v":\d+\}$/)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })()
    try {
      for (let version = 1; version <= rounds; version++) await writePrivateFileAtomic(file, `{"v":${version}}`)
    } finally {
      // Always, or a timeout here leaves the loop reading a directory the next
      // test has already deleted, and fails that test instead of this one.
      loop.reading = false
      await reader.catch(() => undefined)
    }

    expect(readFileSync(file, "utf8")).toBe(`{"v":${rounds}}`)
    expect(readdirSync(dir)).toEqual(["credentials.json"])
  }, 60_000)

  test("a reader that is holding the file open only delays the replacement", async () => {
    // Windows opens without FILE_SHARE_DELETE, so this is the case that fails
    // outright without the bounded wait; on POSIX it simply succeeds at once.
    const file = join(dir, "credentials.json")
    await writePrivateFileAtomic(file, '{"v":0}')

    const held = openSync(file, "r")
    setTimeout(() => closeSync(held), 200)
    await writePrivateFileAtomic(file, secret)

    expect(readFileSync(file, "utf8")).toBe(secret)
    expect(readdirSync(dir)).toEqual(["credentials.json"])
  }, 30_000)

  test("a reader that never lets go either delays the replacement or fails it cleanly", async () => {
    // Whether a held reader blocks the replacement depends on the share mask
    // its runtime chose — libuv adds FILE_SHARE_DELETE and Bun does not — so
    // the contract is what survives either answer, not which one this runtime
    // gives.
    const file = join(dir, "credentials.json")
    await writePrivateFileAtomic(file, '{"v":0}')

    const held = openSync(file, "r")
    const outcome = await writePrivateFileAtomic(file, secret).then(
      () => "replaced" as const,
      (error: unknown) => error,
    )
    closeSync(held)

    if (outcome === "replaced") expect(readFileSync(file, "utf8")).toBe(secret)
    else expect(readFileSync(file, "utf8")).toBe('{"v":0}')
    expect(readdirSync(dir)).toEqual(["credentials.json"])
  }, 30_000)

  test.skipIf(onPosix)("permissions that cannot be applied fail the write before the secret is on disk", async () => {
    const systemRoot = process.env.SystemRoot
    process.env.SystemRoot = join(dir, "no-interpreter-here")
    const file = join(dir, "credentials.json")
    try {
      await expect(writePrivateFileAtomic(file, secret)).rejects.toThrow(PrivateFileError)
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = systemRoot
    }

    expect(readdirSync(dir)).toEqual([])
    expect(() => statSync(file)).toThrow()
  })
})

describe("readJsonFile", () => {
  test("parses the file", () => {
    const file = join(dir, "state.json")
    writeFileSync(file, '{"a":1}')
    expect(readJsonFile(file)).toEqual({ a: 1 })
  })

  test("nothing is swallowed: ENOENT and SyntaxError both surface", () => {
    expect(() => readJsonFile(join(dir, "missing.json"))).toThrow("ENOENT")
    const bad = join(dir, "bad.json")
    writeFileSync(bad, "{")
    expect(() => readJsonFile(bad)).toThrow(SyntaxError)
  })
})

describe("resolvePem", () => {
  test("inline text has its literal escapes rewritten", async () => {
    expect(await resolvePem("-----BEGIN KEY-----\\nbody\\n-----END KEY-----")).toBe(
      "-----BEGIN KEY-----\nbody\n-----END KEY-----",
    )
  })

  test("a path is read verbatim, with its real newlines untouched", async () => {
    const file = join(dir, "key.pem")
    const contents = "-----BEGIN KEY-----\nbody\\nliteral\n"
    writeFileSync(file, contents)
    // The file arm must NOT rewrite escapes: a real file already has real
    // newlines, so a literal backslash-n in it is data.
    expect(await resolvePem(file)).toBe(contents)
  })

  test("a missing path surfaces the read error", async () => {
    await expect(resolvePem(join(dir, "missing.pem"))).rejects.toThrow("ENOENT")
  })
})
