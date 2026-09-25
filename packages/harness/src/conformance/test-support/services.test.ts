import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTestServices } from "./services"

test.skipIf(process.platform === "win32")("retirement kills a descendant that ignores TERM", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-process-group-"))
  const pidFile = path.join(directory, "descendant.pid")
  const script = `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
fs.writeFileSync(process.argv[1],String(child.pid));
setInterval(()=>{},1000);`
  const services = createTestServices()
  const owned = await services.spawn({ file: process.execPath, args: ["-e", script, pidFile], cwd: directory, env: { ...process.env } as Record<string, string> },
    { role: "harness", label: "descendant test" })
  try {
    let descendant = 0
    const until = Date.now() + 2_000
    while (!descendant && Date.now() < until) {
      try { descendant = Number(await fs.readFile(pidFile, "utf8")) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      if (!descendant) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(descendant).toBeGreaterThan(0)
    const first = owned.retire({ at: Date.now() + 2_000, signal: new AbortController().signal })
    expect(owned.retire({ at: Date.now() - 1, signal: new AbortController().signal })).toBe(first)
    const result = await first
    expect(result).toEqual({ stopped: true })
    expect(owned.retire({ at: Date.now() - 1, signal: new AbortController().signal })).toBe(first)
    expect(() => process.kill(descendant, 0)).toThrow()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 10_000)
