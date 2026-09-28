import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { agentHookConfigPaths, materializeAgentHooks } from "./materialize-status-hooks"
import { generateAntigravityHook, generateCursorHook, generateGeminiHook, generateNotifyScript } from "./core/hooks"

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
      force: true,
    })

    expect(results.every((item) => item.status === "applied")).toBe(true)
    for (const personal of [".claude", ".codex"]) {
      await expect(fs.stat(path.join(root, personal))).rejects.toMatchObject({ code: "ENOENT" })
    }
    await expect(readJson(path.join(root, ".gemini", "settings.json"))).resolves.toMatchObject({
      hooks: {
        BeforeAgent: [{ hooks: [{ type: "command", command: geminiHookPath }] }],
      },
    })
    await expect(readJson(path.join(root, ".mastracode", "hooks.json"))).resolves.toMatchObject({
      UserPromptSubmit: [{ type: "command", command: `bash '${notifyPath}' --harness=mastracode` }],
    })
  })

  test("Cursor adds only Claxedo's entries and keeps the person's file byte-for-byte around them", async () => {
    const file = path.join(root, ".cursor", "hooks.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const person = `{
    "version": 1,
    "hooks": {
        "afterFileEdit": [ { "command": "./scripts/format.sh" } ],
        "beforeShellExecution": [
            { "command": "./scripts/approve-network.sh", "matcher": "curl|wget" }
        ]
    },
    "theme": "person-owned"
}
`
    await fs.writeFile(file, person, { mode: 0o600 })
    const input = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath }

    expect((await materializeAgentHooks(input)).find((result) => result.runner === "cursor")?.status).toBe("applied")
    const first = await fs.readFile(file, "utf8")
    expect(first).toContain(`"afterFileEdit": [ { "command": "./scripts/format.sh" } ]`)
    expect(first).toContain(`{ "command": "./scripts/approve-network.sh", "matcher": "curl|wget" }`)
    expect(first).toContain(`"theme": "person-owned"`)
    const hooks = (JSON.parse(first) as { hooks: Record<string, unknown[]> }).hooks
    expect(hooks.beforeShellExecution).toEqual([
      { command: "./scripts/approve-network.sh", matcher: "curl|wget" },
      { command: `${cursorHookPath} PermissionRequest` },
    ])
    expect(hooks.afterFileEdit).toEqual([{ command: "./scripts/format.sh" }])
    expect(hooks.stop).toEqual([{ command: `${cursorHookPath} Stop` }])
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)

    const before = await fs.stat(file)
    await materializeAgentHooks({ ...input, force: true })
    expect(await fs.readFile(file, "utf8")).toBe(first)
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  test.each([
    ["gemini", ".gemini/settings.json", `{
    "theme":   "Dracula",
    "hooks": {
        "BeforeAgent": [ { "hooks": [ { "type": "command", "command": "/user/before.sh" } ] } ]
    }
}
`, `"BeforeAgent": [ { "hooks": [ { "type": "command", "command": "/user/before.sh" } ] }`],
    ["antigravity", ".gemini/config/hooks.json", `{
    "person-lifecycle": { "Stop": [ { "type": "command", "command": "/user/stop.sh" } ] }
}
`, `"person-lifecycle": { "Stop": [ { "type": "command", "command": "/user/stop.sh" } ] }`],
    ["droid", ".factory/hooks.json", `{
    "Stop": [ { "hooks": [ { "type": "command", "command": "/user/stop.sh" } ] } ],
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "/user/start.sh" } ] } ]
}
`, `"SessionStart": [ { "hooks": [ { "type": "command", "command": "/user/start.sh" } ] } ]`],
    ["mastra", ".mastracode/hooks.json", `{
    "Stop": [ { "type": "command", "command": "/user/stop.sh" } ],
    "Custom": [ { "type": "command", "command": "/user/custom.sh" } ]
}
`, `"Custom": [ { "type": "command", "command": "/user/custom.sh" } ]`],
    ["cursor", ".cursor/hooks.json", `{
    "version": 1,
    "hooks": { "afterFileEdit": [ { "command": "./scripts/format.sh" } ] }
}
`, `"afterFileEdit": [ { "command": "./scripts/format.sh" } ]`],
  ])("%s keeps the person's entries byte-for-byte, and a second setup writes nothing", async (runner, relative, person, kept) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, person, { mode: 0o640 })
    const input = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath }
    expect((await materializeAgentHooks(input)).find((result) => result.runner === runner)?.status).toBe("applied")
    const first = await fs.readFile(file, "utf8")
    expect(first).not.toBe(person)
    expect(first).toContain(kept)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
    const before = await fs.stat(file)
    await materializeAgentHooks({ ...input, force: true })
    expect(await fs.readFile(file, "utf8")).toBe(first)
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  test("Amp keeps the person's own plugins and writes its plugin only when it changed", async () => {
    const dir = path.join(root, ".config", "amp", "plugins")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "person.ts"), "person plugin\n")
    const input = { homeDir: root, notifyPath, geminiHookPath, cursorHookPath }
    await materializeAgentHooks(input)
    const plugin = path.join(dir, "claxedo-lifecycle.ts")
    const before = await fs.stat(plugin)
    await materializeAgentHooks({ ...input, force: true })
    expect((await fs.stat(plugin)).mtimeMs).toBe(before.mtimeMs)
    expect(await fs.readFile(path.join(dir, "person.ts"), "utf8")).toBe("person plugin\n")
  })

  test("Cursor refuses a hooks file it cannot merge into without touching it", async () => {
    const file = path.join(root, ".cursor", "hooks.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const content of ['{"version":1,"hooks":{"stop":"not-a-list"}}', "{ not json"]) {
      await fs.writeFile(file, content)
      const results = await materializeAgentHooks({ homeDir: root, notifyPath, geminiHookPath, cursorHookPath })
      expect(results.find((result) => result.runner === "cursor")?.status).toBe("failed")
      expect(await fs.readFile(file, "utf8")).toBe(content)
    }
  })

  test("Cursor writes through a linked hooks file to its target", async () => {
    const target = path.join(root, "dotfiles", "cursor-hooks.json")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{"version":1,"hooks":{}}\n')
    const file = path.join(root, ".cursor", "hooks.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.symlink(target, file)
    await materializeAgentHooks({ homeDir: root, notifyPath, geminiHookPath, cursorHookPath })
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, "utf8")).toContain(`${cursorHookPath} Stop`)
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
    const command = `'${notifyPath}' --harness=droid`
    expect(await readJson(file)).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      Notification: [{ hooks: [{ type: "command", command }] }],
      Stop: [user, { hooks: [{ type: "command", command }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
    })
    expect(await readJson(settings)).toEqual({ model: "keep", hooks: { Stop: [user] } })
  })

  test("Droid registers in settings.json when that is where its hooks live, and never creates hooks.json", async () => {
    const directory = path.join(root, ".factory")
    await fs.mkdir(directory)
    const user = { hooks: [{ type: "command", command: "/user/start.sh" }] }
    await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ model: "keep", hooks: { SessionStart: [user] } }))
    await materializeAgentHooks({ homeDir: root, notifyPath, geminiHookPath, cursorHookPath })
    await expect(fs.stat(path.join(directory, "hooks.json"))).rejects.toMatchObject({ code: "ENOENT" })
    const settings = await readJson(path.join(directory, "settings.json")) as { model: string; hooks: Record<string, unknown[]> }
    expect(settings.model).toBe("keep")
    expect(settings.hooks.SessionStart).toEqual([user])
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `'${notifyPath}' --harness=droid` }] }])
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

  test("reports a corrupted settings file as failed instead of rewriting it", async () => {
    const geminiPath = path.join(root, ".gemini", "settings.json")
    await fs.mkdir(path.dirname(geminiPath), { recursive: true })
    await fs.writeFile(geminiPath, "{ this is not json")

    const results = await materializeAgentHooks({
      homeDir: root,
      notifyPath,
      geminiHookPath,
      cursorHookPath,
      force: true,
    })

    const gemini = results.find((item) => item.runner === "gemini")
    expect(gemini?.status).toBe("failed")
    expect(gemini?.reason).toContain("invalid JSON")
    await expect(fs.readFile(geminiPath, "utf8")).resolves.toBe("{ this is not json")
    expect(results.filter((item) => item.runner !== "gemini").every((item) => item.status === "applied")).toBe(true)
  })

})

function hookCommandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommandsIn)
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  return [...(typeof record.command === "string" ? [record.command] : []), ...Object.values(record).flatMap(hookCommandsIn)]
}

async function commandsIn(file: string) {
  return hookCommandsIn(await readJson(file)).sort()
}

function times(count: number, command: string) {
  return Array.from({ length: count }, () => command)
}

function scriptsIn(dataRoot: string) {
  const hooks = path.join(dataRoot, "hooks")
  return {
    notify: path.join(hooks, "notify.sh"),
    gemini: path.join(hooks, "gemini-hook.sh"),
    cursor: path.join(hooks, "cursor-hook.sh"),
    antigravity: path.join(hooks, "antigravity-hook.sh"),
  }
}

async function writeGeneratedScripts(dataRoot: string) {
  const scripts = scriptsIn(dataRoot)
  await fs.mkdir(path.dirname(scripts.notify), { recursive: true })
  await fs.writeFile(scripts.notify, generateNotifyScript(7860), { mode: 0o755 })
  await fs.writeFile(scripts.gemini, generateGeminiHook(scripts.notify), { mode: 0o755 })
  await fs.writeFile(scripts.cursor, generateCursorHook(scripts.notify), { mode: 0o755 })
  await fs.writeFile(scripts.antigravity, generateAntigravityHook(scripts.notify), { mode: 0o755 })
  return scripts
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}

describe("materializeAgentHooks across data roots", () => {
  let home: string
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-data-roots-"))
  })
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true })
  })

  function materializeFor(scripts: ReturnType<typeof scriptsIn>) {
    return materializeAgentHooks({
      homeDir: home,
      notifyPath: scripts.notify,
      geminiHookPath: scripts.gemini,
      cursorHookPath: scripts.cursor,
    })
  }

  test("a run from a fresh temp data root leaves one registration per event, not one per past run", async () => {
    let last = scriptsIn(home)
    for (const run of ["run-1", "run-2", "run-3"]) {
      const dataRoot = path.join(home, "tmp", run)
      last = await writeGeneratedScripts(dataRoot)
      expect((await materializeFor(last)).filter((result) => result.status !== "applied")).toEqual([])
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
    const files = agentHookConfigPaths(home)
    expect(await commandsIn(files.gemini)).toEqual(times(3, last.gemini))
    expect(await commandsIn(files.mastra)).toEqual(times(3, `bash '${last.notify}' --harness=mastracode`))
    expect(await commandsIn(files.droid)).toEqual(times(4, `'${last.notify}' --harness=droid`))
    expect((await commandsIn(files.cursor)).length).toBe(6)
    expect(await commandsIn(files.antigravity)).toEqual([
      `bash '${last.antigravity}' PreInvocation`,
      `bash '${last.antigravity}' Stop`,
    ])
  })

  test("retires generated registrations from other data roots and keeps foreign ones", async () => {
    const current = await writeGeneratedScripts(path.join(home, ".workspace-runtime"))
    const previous = await writeGeneratedScripts(path.join(home, "previous-data"))
    const deleted = scriptsIn(path.join(home, "deleted-data"))
    const foreign = path.join(home, ".superset", "hooks", "notify.sh")
    await fs.mkdir(path.dirname(foreign), { recursive: true })
    await fs.writeFile(foreign, "#!/bin/bash\n# Superset agent notification hook\n", { mode: 0o755 })
    const guardedMissing = `if [ -x '${deleted.gemini}' ]; then /bin/sh '${deleted.gemini}'; fi`
    const command = (value: string) => ({ type: "command", command: value })
    const files = agentHookConfigPaths(home)
    const droidSettings = files.droid
    const droidHooks = path.join(path.dirname(files.droid), "hooks.json")

    await writeJson(droidHooks, {
      Stop: [{ hooks: [command(deleted.notify)] }, { hooks: [command(foreign)] }],
      PostToolUse: [{ matcher: "*", hooks: [command(`'${previous.notify}' --harness=droid`)] }],
    })
    await writeJson(droidSettings, { hooks: { Stop: [{ hooks: [command(deleted.notify), command(foreign)] }] } })
    await writeJson(files.mastra, {
      Stop: [command(`bash '${deleted.notify}'`), command(`bash '${foreign}'`)],
      UserPromptSubmit: [command(`bash '${previous.notify}' --harness=mastracode`)],
      Notification: [command(`bash '${deleted.notify}'`)],
    })
    await writeJson(files.gemini, { hooks: { BeforeAgent: [
      { hooks: [command(deleted.gemini)] },
      { hooks: [command(previous.gemini)] },
      { hooks: [command(guardedMissing)] },
    ], Notification: [
      { hooks: [command(previous.gemini), command("/user/gemini-notify.sh")] },
      { hooks: [command(deleted.gemini)] },
    ] } })
    await writeJson(files.cursor, { version: 1, hooks: { stop: [
      { command: `${deleted.cursor} Stop` },
      { command: `${previous.cursor} Stop` },
      { command: "./scripts/format.sh" },
    ], afterAgentResponse: [{ command: `${deleted.cursor} Stop` }] } })
    await writeJson(files.antigravity, { "claxedo-lifecycle": {
      PreInvocation: [{ ...command(`bash '${previous.antigravity}' PreInvocation`), timeout: 3 }],
      Stop: [{ ...command(`bash '${deleted.antigravity}' Stop`), timeout: 3 }],
    } })

    for (let i = 0; i < 2; i++) {
      expect((await materializeFor(current)).filter((result) => result.status !== "applied")).toEqual([])
    }

    const sorted = (...commands: string[]) => commands.sort()
    expect(await commandsIn(droidHooks)).toEqual(sorted(foreign, ...times(4, `'${current.notify}' --harness=droid`)))
    expect(await commandsIn(droidSettings)).toEqual([foreign])
    expect(await commandsIn(files.mastra)).toEqual(sorted(`bash '${foreign}'`, ...times(3, `bash '${current.notify}' --harness=mastracode`)))
    expect(await commandsIn(files.gemini)).toEqual(sorted(guardedMissing, "/user/gemini-notify.sh", ...times(3, current.gemini)))
    expect(Object.keys((await readJson(files.cursor)).hooks as object)).not.toContain("afterAgentResponse")
    expect((await commandsIn(files.cursor)).filter((value) => !value.startsWith(`${current.cursor} `))).toEqual(["./scripts/format.sh"])
    expect(await commandsIn(files.antigravity)).toEqual([
      `bash '${current.antigravity}' PreInvocation`,
      `bash '${current.antigravity}' Stop`,
    ])
  })

  test("the script's marker, not its path, decides ownership of an existing notify.sh", async () => {
    const current = await writeGeneratedScripts(path.join(home, ".workspace-runtime"))
    const other = path.join(home, ".superset", "hooks", "notify.sh")
    await fs.mkdir(path.dirname(other), { recursive: true })
    await fs.writeFile(other, "#!/bin/bash\n# Superset agent notification hook\n", { mode: 0o755 })
    const file = path.join(path.dirname(agentHookConfigPaths(home).droid), "hooks.json")
    await writeJson(file, { Stop: [{ hooks: [{ type: "command", command: other }] }] })

    await materializeFor(current)
    expect(await commandsIn(file)).toContain(other)

    await fs.writeFile(other, generateNotifyScript(7860))
    await materializeFor(current)
    expect(await commandsIn(file)).toEqual(times(4, `'${current.notify}' --harness=droid`))
  })

  test("Antigravity refuses a claxedo-lifecycle hook whose script exists without the marker", async () => {
    const current = await writeGeneratedScripts(path.join(home, ".workspace-runtime"))
    const other = path.join(home, "elsewhere", "hooks", "antigravity-hook.sh")
    await fs.mkdir(path.dirname(other), { recursive: true })
    await fs.writeFile(other, "#!/bin/sh\necho mine\n")
    const file = agentHookConfigPaths(home).antigravity
    const original = { "claxedo-lifecycle": { Stop: [{ type: "command", command: `bash '${other}' Stop` }] } }
    await writeJson(file, original)

    expect((await materializeFor(current)).find((result) => result.runner === "antigravity")?.status).toBe("failed")
    expect(await readJson(file)).toEqual(original)
  })
})
