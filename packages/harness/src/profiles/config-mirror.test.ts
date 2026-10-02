import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mirrorConfigTree } from "./config-mirror"

test("mirrored hooks stay executable and private", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "config-mirror-executable-")))
  try {
    const source = path.join(root, "source")
    const target = path.join(root, "target")
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, "hook.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await fs.writeFile(path.join(source, "settings.json"), "{}", { mode: 0o644 })
    await mirrorConfigTree(source, target, root, { secretFile: /^auth\.json$/ })
    expect((await fs.stat(path.join(target, "hook.sh"))).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(target, "settings.json"))).mode & 0o777).toBe(0o600)
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("mode-only source changes invalidate the mirror cache in both directions", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "config-mirror-mode-")))
  try {
    const source = path.join(root, "hook.sh")
    const target = path.join(root, "copy.sh")
    await fs.writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const initial = await fs.stat(source)
    const mirror = () => mirrorConfigTree(source, target, root, { secretFile: /^auth\.json$/ })
    await mirror()
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
    await fs.chmod(source, 0o755)
    expect((await fs.stat(source)).mtimeMs).toBe(initial.mtimeMs)
    await mirror()
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700)
    await fs.chmod(source, 0o644)
    await mirror()
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(target, "utf8")).toBe(await fs.readFile(source, "utf8"))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a mirrored entry the person removed goes even when its name ends in .tmp, and only the mirror's own staging names stay", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "config-mirror-prune-")))
  try {
    const source = path.join(root, "skills")
    const target = path.join(root, "copy")
    await fs.mkdir(path.join(source, "kept.tmp"), { recursive: true })
    await fs.mkdir(path.join(target, "removed.tmp"), { recursive: true })
    const staging = `.kept.tmp.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.join(target, staging))
    await mirrorConfigTree(source, target, root, { secretFile: /^auth\.json$/ })
    expect((await fs.readdir(target)).sort()).toEqual([staging, "kept.tmp"])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
