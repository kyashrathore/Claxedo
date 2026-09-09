import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { getClaudeManagedHookCommand, materializeAgentHooks } from "./materialize-status-hooks"

const root = path.join(os.tmpdir(), `agent-hooks-materializer-${randomUUID().slice(0, 8)}`)
const notifyPath = path.join(root, ".claxedo", "hooks", "notify.sh")
const geminiHookPath = path.join(root, ".claxedo", "hooks", "gemini-hook.sh")
const cursorHookPath = path.join(root, ".claxedo", "hooks", "cursor-hook.sh")

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

test("Antigravity preserves user hooks, installs idempotently, and refuses a named collision", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-hooks-"))
  const file = path.join(home, ".gemini/config/hooks.json")
  const options = { homeDir: home, notifyPath, geminiHookPath, cursorHookPath }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const user = { Stop: [{ command: "echo user-owned" }] }
    await fs.writeFile(file, JSON.stringify({ user }))
    expect((await materializeAgentHooks(options)).find((r) => r.runner === "antigravity")?.status).toBe("applied")
    const first = await fs.readFile(file, "utf8")
    expect(JSON.parse(first).user).toEqual(user)
    await materializeAgentHooks(options)
    expect(await fs.readFile(file, "utf8")).toBe(first)
    await fs.writeFile(file, JSON.stringify({ "claxedo-lifecycle": user }))
    expect((await materializeAgentHooks(options)).find((r) => r.runner === "antigravity")?.status).toBe("failed")
    expect(await readJson(file)).toEqual({ "claxedo-lifecycle": user })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

describe("materializeAgentHooks", () => {
  test("Amp installs only its own plugin and rejects collisions with user files", async () => {
    const dir = path.join(root, ".config", "amp", "plugins")
    await fs.mkdir(dir, { recursive: true })
    const user = path.join(dir, "user.ts")
    await fs.writeFile(user, "user plugin")
    const options = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath }
    expect((await materializeAgentHooks(options)).find((result) => result.runner === "amp")?.status).toBe("applied")
    const file = path.join(dir, "claxedo-lifecycle.ts")
    const content = await fs.readFile(file, "utf8")
    await materializeAgentHooks(options)
    expect(await fs.readFile(file, "utf8")).toBe(content)
    expect(await fs.readFile(user, "utf8")).toBe("user plugin")
    await fs.writeFile(file, "user owned collision")
    expect((await materializeAgentHooks(options)).find((result) => result.runner === "amp")?.status).toBe("failed")
    expect(await fs.readFile(file, "utf8")).toBe("user owned collision")
  })
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
        Interrupt: [{ hooks: [{ type: "command", command: notifyPath }] }],
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

  test("Droid uses standalone hooks and retires only its owned settings entries", async () => {
    const directory = path.join(root, ".factory")
    await fs.mkdir(directory)
    const settings = path.join(directory, "settings.json")
    const file = path.join(directory, "hooks.json")
    const user = { hooks: [{ type: "command", command: "/user/hook.sh" }] }
    await fs.writeFile(settings, JSON.stringify({ model: "keep", hooks: {
      Stop: [{ hooks: [{ type: "command", command: notifyPath }, ...user.hooks] }],
    } }))
    await fs.writeFile(file, JSON.stringify({ Stop: [user] }))
    const input = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath }
    for (let i = 0; i < 2; i++) await materializeAgentHooks(input)
    expect(await readJson(file)).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: "command", command: notifyPath }] }],
      Notification: [{ hooks: [{ type: "command", command: notifyPath }] }],
      Stop: [user, { hooks: [{ type: "command", command: notifyPath }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: notifyPath }] }],
    })
    expect(await readJson(settings)).toEqual({ model: "keep", hooks: { Stop: [user] } })
  })

  test("Droid preserves effective settings hooks when creating the standalone file", async () => {
    const directory = path.join(root, ".factory")
    await fs.mkdir(directory)
    const user = { hooks: [{ type: "command", command: "/user/start.sh" }] }
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ hooks: { SessionStart: [user] } }))
    await materializeAgentHooks({ homeDir: root, notifyPath, geminiHookPath, cursorHookPath })
    expect(await readJson(path.join(directory, "hooks.json"))).toMatchObject({ SessionStart: [user] })
  })

  test("Droid refuses a malformed standalone file without pruning working settings", async () => {
    const directory = path.join(root, ".factory")
    await fs.mkdir(directory)
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: notifyPath }] }] } })
    await fs.writeFile(path.join(directory, "settings.json"), original)
    await fs.writeFile(path.join(directory, "hooks.json"), "{broken")
    const results = await materializeAgentHooks({ homeDir: root, notifyPath, geminiHookPath, cursorHookPath })
    expect(results.find((item) => item.runner === "droid")?.status).toBe("failed")
    expect(await fs.readFile(path.join(directory, "settings.json"), "utf8")).toBe(original)
    expect(await fs.readFile(path.join(directory, "hooks.json"), "utf8")).toBe("{broken")
  })

  test("retires Claude child completion hooks without removing user commands", async () => {
    const file = path.join(root, ".claude", "settings.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hooks: {
      SubagentStop: [{ hooks: [
        { type: "command", command: getClaudeManagedHookCommand() },
        { type: "command", command: "/user/child-completed.sh" },
      ] }],
    } }))
    const input = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath, force: true }
    await materializeAgentHooks(input)
    await materializeAgentHooks(input)
    const result = await readJson(file)
    expect(result).toMatchObject({ hooks: {
      SubagentStop: [{ hooks: [{ type: "command", command: "/user/child-completed.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: getClaudeManagedHookCommand() }] }],
    } })
  })

  test("reports a corrupted settings file as failed instead of rewriting it", async () => {
    const claudePath = path.join(root, ".claude", "settings.json")
    await fs.mkdir(path.dirname(claudePath), { recursive: true })
    await fs.writeFile(claudePath, "{ this is not json")

    const results = await materializeAgentHooks({
      homeDir: root,
      notifyPath,
      geminiHookPath,
      cursorHookPath,
      force: true,
    })

    const claude = results.find((item) => item.runner === "claude")
    expect(claude?.status).toBe("failed")
    expect(claude?.reason).toContain("invalid JSON")
    await expect(fs.readFile(claudePath, "utf8")).resolves.toBe("{ this is not json")
    expect(results.filter((item) => item.runner !== "claude").every((item) => item.status === "applied")).toBe(true)
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
