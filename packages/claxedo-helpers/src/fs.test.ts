import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readJsonFile, resolvePem, writeFileAtomic, writeFileAtomicSync } from "./fs"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claxedo-helpers-fs-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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

  test("defaults to owner-only 0600", async () => {
    const file = join(dir, "secret")
    await writeFileAtomic(file, "s")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("an explicit mode is honoured", async () => {
    const file = join(dir, "public")
    await writeFileAtomic(file, "s", { mode: 0o644 })
    expect(statSync(file).mode & 0o777).toBe(0o644)
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
})

describe("writeFileAtomicSync", () => {
  test("same result, synchronously", () => {
    const file = join(dir, "state.json")
    writeFileAtomicSync(file, "sync")
    expect(readFileSync(file, "utf8")).toBe("sync")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(["state.json"])
  })

  test("mkdir creates the parents", () => {
    const nested = join(dir, "a", "b", "state.json")
    writeFileAtomicSync(nested, "x", { mkdir: true })
    expect(readFileSync(nested, "utf8")).toBe("x")
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
