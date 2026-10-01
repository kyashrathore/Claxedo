import { defaultStatusHooks } from "../status-hooks"
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigChangedError, readConfig, writeMergedConfig } from "./config-merge"
import { materializeAgentHooks } from "./materialize-status-hooks"

let root: string
const input = () => ({
  templates: defaultStatusHooks, homeDir: root,
  notifyPath: path.join(root, ".claxedo", "hooks", "notify.sh"),
})
const cursorResult = async () => (await materializeAgentHooks(input())).find((result) => result.runner === "cursor")!

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "config-merge-")) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function personFile(content: string, mode = 0o644) {
  const file = path.join(root, ".cursor", "hooks.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, { mode })
  return file
}

test("a file that repeats a key is refused and left as it was", async () => {
  const content = '{"hooks":{"stop":[{"command":"person-first-A"}]},"hooks":{"stop":[{"command":"person-B"}]}}'
  const file = await personFile(content)
  const result = await cursorResult()
  expect(result.status).toBe("failed")
  expect(result.reason).toContain('repeats the key "hooks"')
  expect(await fs.readFile(file, "utf8")).toBe(content)
})

test("a file the person made read-only is refused and never replaced", async () => {
  const file = await personFile('{"hooks":{}}', 0o444)
  const result = await cursorResult()
  expect(result.status).toBe("failed")
  expect(result.reason).toContain("read-only")
  expect(await fs.readFile(file, "utf8")).toBe('{"hooks":{}}')
  expect((await fs.stat(file)).mode & 0o777).toBe(0o444)
})

test("a link that points nowhere is refused and kept as a link", async () => {
  const file = path.join(root, ".cursor", "hooks.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.symlink(path.join(root, "dotfiles", "missing.json"), file)
  const result = await cursorResult()
  expect(result.status).toBe("failed")
  expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
})

test("a hard-linked file is rewritten in place, so every name sees the merge", async () => {
  const file = await personFile('{"hooks":{}}')
  const other = path.join(root, "dotfiles-hooks.json")
  await fs.link(file, other)
  const inode = (await fs.stat(file)).ino
  expect((await cursorResult()).status).toBe("applied")
  expect((await fs.stat(file)).ino).toBe(inode)
  expect(await fs.readFile(other, "utf8")).toBe(await fs.readFile(file, "utf8"))
  expect(await fs.readFile(other, "utf8")).toContain("cursor-hook.sh Stop")
})

test("a file that changed after it was read is not overwritten", async () => {
  const file = await personFile('{"hooks":{}}')
  const { original } = await readConfig(file)
  await fs.writeFile(file, '{"hooks":{"stop":[{"command":"edited meanwhile"}]}}')
  await expect(writeMergedConfig(file, original, '{"hooks":{"stop":[]}}')).rejects.toBeInstanceOf(ConfigChangedError)
  expect(await fs.readFile(file, "utf8")).toBe('{"hooks":{"stop":[{"command":"edited meanwhile"}]}}')
})

test("comments, a byte-order mark and a non-object root are refused", async () => {
  for (const content of ['{"hooks":{} // mine\n}', '﻿{"hooks":{}}', "[1,2]"]) {
    const file = await personFile(content)
    expect((await cursorResult()).status).toBe("failed")
    expect(await fs.readFile(file, "utf8")).toBe(content)
  }
})
