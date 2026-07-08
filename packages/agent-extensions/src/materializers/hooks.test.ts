import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { getClaudeManagedHookCommand, materializeAgentHooks } from "./hooks"

const root = path.join(os.tmpdir(), `agent-hooks-materializer-${randomUUID().slice(0, 8)}`)
const notifyPath = path.join(root, ".claxedo", "hooks", "notify.sh")
const geminiHookPath = path.join(root, ".claxedo", "hooks", "gemini-hook.sh")
const cursorHookPath = path.join(root, ".claxedo", "hooks", "cursor-hook.sh")

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

describe("materializeAgentHooks", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("writes external agent hook config under the provided home dir", async () => {
    const results = await materializeAgentHooks({
      homeDir: root,
      notifyPath,
      geminiHookPath,
      cursorHookPath,
      codexNativeHooks: true,
      force: true,
    })

    expect(results.every((item) => item.status === "applied")).toBe(true)
    await expect(readJson(path.join(root, ".claude", "settings.json"))).resolves.toMatchObject({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: getClaudeManagedHookCommand() }] }],
      },
    })
    await expect(readJson(path.join(root, ".codex", "hooks.json"))).resolves.toMatchObject({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: notifyPath }] }],
      },
    })
    await expect(readJson(path.join(root, ".gemini", "settings.json"))).resolves.toMatchObject({
      hooks: {
        BeforeAgent: [{ hooks: [{ type: "command", command: geminiHookPath }] }],
      },
    })
    await expect(readJson(path.join(root, ".cursor", "hooks.json"))).resolves.toMatchObject({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: `${cursorHookPath} Start` }],
      },
    })
    await expect(readJson(path.join(root, ".mastracode", "hooks.json"))).resolves.toMatchObject({
      UserPromptSubmit: [{ type: "command", command: `bash '${notifyPath}'` }],
    })
  })

  test("preserves user hooks and removes stale managed Codex hooks when native hooks are disabled", async () => {
    const codexPath = path.join(root, ".codex", "hooks.json")
    await fs.mkdir(path.dirname(codexPath), { recursive: true })
    await fs.writeFile(codexPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "/old/.claxedo/hooks/notify.sh" }] },
          { hooks: [{ type: "command", command: "/user/hook.sh" }] },
        ],
      },
    }, null, 2))

    await materializeAgentHooks({
      homeDir: root,
      notifyPath,
      geminiHookPath,
      cursorHookPath,
      codexNativeHooks: false,
      force: true,
    })

    expect(await readJson(codexPath)).toEqual({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "/user/hook.sh" }] },
        ],
      },
    })
  })
})
