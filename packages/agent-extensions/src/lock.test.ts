import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { encodeLock, lockStatePath, readExtensionLock, writeExtensionLock } from "./lock"

const root = path.join(os.tmpdir(), `agent-extensions-lock-${randomUUID().slice(0, 8)}`)

describe("Agent Extension lock state", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("returns an empty versioned lock when missing", async () => {
    await expect(readExtensionLock(lockStatePath(root))).resolves.toEqual({
      version: 1,
      packages: {},
    })
  })

  test("encodes lock records deterministically", async () => {
    const lock = {
      version: 1 as const,
      packages: {
        zeta: {
          source: { type: "github" as const, owner: "acme", repo: "tools" },
          resolved_sha: "bbb",
          manifest_digests: { "z.json": "2", "a.json": "1" },
          component_digests: { "skill/SKILL.md": "2", "README.md": "1" },
          targets: ["cursor" as const, "claude" as const],
        },
        alpha: {
          source: { type: "github" as const, owner: "acme", repo: "tools" },
          resolved_sha: "aaa",
          package_path: "packages/alpha",
          manifest_digests: {},
          component_digests: {},
          targets: ["codex" as const],
        },
      },
    }

    await writeExtensionLock(lockStatePath(root), lock)

    expect(await fs.readFile(lockStatePath(root), "utf8")).toBe(encodeLock(lock))
    expect(await readExtensionLock(lockStatePath(root))).toEqual({
      version: 1,
      packages: {
        alpha: {
          source: { type: "github", owner: "acme", repo: "tools" },
          resolved_sha: "aaa",
          package_path: "packages/alpha",
          manifest_digests: {},
          component_digests: {},
          targets: ["codex"],
        },
        zeta: {
          source: { type: "github", owner: "acme", repo: "tools" },
          resolved_sha: "bbb",
          manifest_digests: { "a.json": "1", "z.json": "2" },
          component_digests: { "README.md": "1", "skill/SKILL.md": "2" },
          targets: ["claude", "cursor"],
        },
      },
    })
  })
})
