import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { agentPluginTree } from "./tree"
import { writeAgentPluginTreeToDirectory } from "./node-tree"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("portable Agent Plugin tree materialization", () => {
  test("writes exact bytes and executable bits without a source filesystem root", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-tree-write-"))
    roots.push(parent)
    const destination = path.join(parent, "plugin")
    await writeAgentPluginTreeToDirectory(agentPluginTree([
      { path: "bin", kind: "directory" },
      { path: "bin/run", kind: "file", bytes: new TextEncoder().encode("#!/bin/sh\n"), executableMode: 0o111 },
      { path: "plugin.json", kind: "file", bytes: new TextEncoder().encode("{}"), executableMode: 0 },
    ]), destination)
    expect(await fs.readFile(path.join(destination, "bin/run"), "utf8")).toBe("#!/bin/sh\n")
    expect((await fs.stat(path.join(destination, "bin/run"))).mode & 0o111).toBe(0o111)
  })

  test("removes a partial destination if an invalid entry is encountered", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-tree-write-"))
    roots.push(parent)
    const destination = path.join(parent, "plugin")
    await expect(writeAgentPluginTreeToDirectory(agentPluginTree([
      { path: "plugin.json", kind: "file", bytes: new Uint8Array(), executableMode: 0 },
      { path: "unsafe", kind: "invalid", reason: "unsupported-entry" },
    ]), destination)).rejects.toThrow("invalid entry")
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
