import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { defaultGenericWrappers, defaultStatusHooks } from "../status-hooks"
import { template } from "../test-support/status-hooks"
import { runInCmd, writeNpmShimRecorder } from "../test-support/windows-cli"
import { installedTemplates } from "./core/platform"
import { hookVariables } from "./core/render"
import { createStatusHooksManifest, writeStatusHooksArtifacts } from "./core/setup"
import { materializeAgentHooks } from "./materialize-status-hooks"

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "windows-status-hooks-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function windowsArtifacts(name: string, port = 4312) {
  const manifest = createStatusHooksManifest(path.join(root, name), "windows")
  await writeStatusHooksArtifacts(manifest, { templates: defaultStatusHooks, genericWrappers: defaultGenericWrappers, port })
  return manifest
}

async function filesUnder(dir: string) {
  const names = await fs.readdir(dir, { recursive: true })
  const files: string[] = []
  for (const name of names) if ((await fs.stat(path.join(dir, name))).isFile()) files.push(name.replaceAll("\\", "/"))
  return files.sort()
}

const cursorStops = async (file: string) =>
  (JSON.parse(await fs.readFile(file, "utf8")) as { hooks: { stop: { command: string }[] } }).hooks.stop.map(
    (hook) => hook.command,
  )

describe("Windows status hooks as written", () => {
  test("setup writes batch wrappers and hooks for the templates that declare Windows, and no shell startup files", async () => {
    const manifest = await windowsArtifacts("written")
    const files = await filesUnder(manifest.dirs.root)
    expect(files).toEqual([
      "bin/aider.cmd",
      "bin/claude.cmd",
      "bin/cline.cmd",
      "bin/codex.cmd",
      "bin/cursor-agent.cmd",
      "bin/cursor.cmd",
      "bin/goose.cmd",
      "hooks/claude-settings.json",
      "hooks/cursor-hook.cmd",
      "hooks/notify.cmd",
    ])
    for (const file of files.filter((name) => name.endsWith(".cmd"))) {
      const text = await fs.readFile(path.join(manifest.dirs.root, file), "utf8")
      expect({ file, bareLineFeed: /(^|[^\r])\n/.test(text) }).toEqual({ file, bareLineFeed: false })
    }
    const settings = JSON.parse(await fs.readFile(path.join(manifest.dirs.hooks, "claude-settings.json"), "utf8"))
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: manifest.files.notify, args: ["--harness=claude"] }] },
    ])
    expect(Object.keys(settings.hooks)).toEqual(Object.keys(JSON.parse(template("claude").artifacts![0].content).hooks))
  })

  test("only the templates that declare a Windows installation are installed there", () => {
    expect(installedTemplates(defaultStatusHooks, "windows").map((item) => item.command)).toEqual(["claude", "codex", "cursor"])
  })

  test("a data root cmd.exe cannot quote is refused instead of written", async () => {
    const manifest = createStatusHooksManifest(path.join(root, "100%"), "windows")
    await expect(
      writeStatusHooksArtifacts(manifest, { templates: defaultStatusHooks, genericWrappers: defaultGenericWrappers }),
    ).rejects.toThrow("cmd.exe cannot pass")
  })

  test("Cursor's registration is cmd-quoted, keeps the person's entries, and replaces Claxedo's own from an earlier data root", async () => {
    const home = path.join(root, "cursor-home")
    const file = path.join(home, ".cursor", "hooks.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"version":1,"hooks":{"stop":[{"command":"person.cmd"}]}}\n')
    const materialize = (notifyPath: string) =>
      materializeAgentHooks({ homeDir: home, notifyPath, templates: defaultStatusHooks, platform: "windows" })

    const earlier = await windowsArtifacts("cursor-earlier")
    expect(await materialize(earlier.files.notify)).toEqual([
      { runner: "cursor", component: "hooks", type: "hook", path: file, status: "applied" },
    ])
    expect(await cursorStops(file)).toEqual(["person.cmd", `"${path.join(earlier.dirs.hooks, "cursor-hook.cmd")}" Stop`])

    const current = await windowsArtifacts("cursor-current")
    await materialize(current.files.notify)
    const merged = await fs.readFile(file, "utf8")
    expect(await cursorStops(file)).toEqual(["person.cmd", `"${path.join(current.dirs.hooks, "cursor-hook.cmd")}" Stop`])
    await materialize(current.files.notify)
    expect(await fs.readFile(file, "utf8")).toBe(merged)
  })
})

type Delivery = { form: URLSearchParams; authorization?: string; workspace?: string }

describe.skipIf(process.platform !== "win32")("Windows status hooks under cmd.exe", () => {
  const deliveries: Delivery[] = []
  let server: http.Server
  let port: number
  let manifest: Awaited<ReturnType<typeof windowsArtifacts>>
  let fakes: string

  beforeAll(async () => {
    server = http.createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on("end", () => {
        deliveries.push({
          form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
          authorization: incoming.headers.authorization,
          workspace: incoming.headers["x-workspace-id"] as string | undefined,
        })
        outgoing.writeHead(200, { "content-type": "application/json" }).end("{}")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
    manifest = await windowsArtifacts("cmd", port)
    fakes = path.join(root, "fake-clis")
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function env(extra: Record<string, string | undefined> = {}) {
    const system = process.env.SystemRoot ?? "C:\\Windows"
    const base: Record<string, string | undefined> = {
      SystemRoot: system,
      ComSpec: process.env.ComSpec ?? path.join(system, "System32", "cmd.exe"),
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      PATH: `${manifest.dirs.bin};${path.join(system, "System32")}`,
      CLAXEDO_TAB_ID: "tab-1",
      CLAXEDO_TERMINAL_ID: "terminal-1",
      CLAXEDO_WORKSPACE_ID: "workspace-1",
      CLAXEDO_SERVER_PORT: String(port),
      CLAXEDO_AGENT_HOOK_TOKEN: "hook-token",
      ...extra,
    }
    return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined))
  }

  const cmd = (line: string, options: { env: Record<string, string>; stdin?: string; switches?: string[] }) =>
    runInCmd(line, { ...options, cwd: root })

  async function fakeCli(name: string) {
    const dir = path.join(fakes, name)
    await writeNpmShimRecorder(dir, name)
    return { dir, argv: path.join(dir, "argv.json") }
  }

  function deliveredSince(count: number): Record<string, string | undefined>[] {
    return deliveries.slice(count).map(({ form, authorization, workspace }) => ({
      ...Object.fromEntries(form),
      authorization,
      workspace,
    }))
  }

  test("Codex's hook command posts the provider JSON from stdin, unchanged, from PowerShell and from cmd.exe", async () => {
    const command = hookVariables(template("codex"), manifest.files.notify, "windows").notifyCommand
    const event = JSON.stringify({ hook_event_name: "Stop", text: 'a & b | "c" %PATH% ^ ! < > π' })
    const delivered = {
      tabId: "tab-1",
      terminalId: "terminal-1",
      workspaceId: "workspace-1",
      provider: "codex",
      providerEvent: event,
      authorization: "Bearer hook-token",
      workspace: "workspace-1",
    }

    const before = deliveries.length
    const started = Date.now()
    const powershell = spawn(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-Command", command],
      { env: env(), stdio: ["pipe", "pipe", "pipe"] },
    )
    let stderr = ""
    powershell.stderr.on("data", (chunk: Buffer) => (stderr += chunk))
    powershell.stdin.end(event)
    const code = await new Promise<number | null>((resolve, reject) => {
      powershell.once("error", reject)
      powershell.once("close", resolve)
    })
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    // A cmdlet under this reduced environment spends 12-23 s on module discovery; the hook runs none.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(deliveredSince(before)).toEqual([delivered])

    const fromCmd = deliveries.length
    expect(await cmd(command, { env: env(), stdin: event, switches: [] })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(deliveredSince(fromCmd)).toEqual([delivered])
  })

  test("notify.cmd drops another harness's hook, a Claude replay under Cursor, and every call outside a tab", async () => {
    const before = deliveries.length
    const event = '{"hook_event_name":"Stop"}'
    const notify = `"${manifest.files.notify}"`
    await cmd(`${notify} --harness=codex`, { env: env({ CLAXEDO_AGENT: "claude" }), stdin: event })
    await cmd(`${notify} --harness=claude`, { env: env({ CURSOR_VERSION: "1.0" }), stdin: event })
    await cmd(`${notify} --harness=codex`, { env: env({ CLAXEDO_TAB_ID: undefined }), stdin: event })
    expect(deliveredSince(before)).toEqual([])
    await cmd(`${notify} --harness=cursor`, { env: env({ CLAXEDO_AGENT: "cursor-agent" }), stdin: event })
    expect(deliveredSince(before).map((row) => row.provider)).toEqual(["cursor-agent"])
  })

  test("Claude's exec form starts notify.cmd with no shell", async () => {
    const before = deliveries.length
    const child = spawn(manifest.files.notify, ["--harness=claude"], { env: env(), stdio: ["pipe", "ignore", "ignore"] })
    child.stdin.end('{"hook_event_name":"UserPromptSubmit"}')
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    expect(code).toBe(0)
    expect(deliveredSince(before).map((row) => [row.provider, row.providerEvent])).toEqual([
      ["claude", '{"hook_event_name":"UserPromptSubmit"}'],
    ])
  })

  test("a generic wrapper reports Busy, then Idle or Error with the real CLI's exit code", async () => {
    const { dir, argv } = await fakeCli("aider")
    const tab = (exit: string) => env({ PATH: `${manifest.dirs.bin};${dir};${env().PATH}`, FAKE_ARGV: argv, FAKE_EXIT: exit })

    const before = deliveries.length
    expect((await cmd('aider --message "fix & ship"', { env: tab("0") })).code).toBe(0)
    expect(JSON.parse(await fs.readFile(argv, "utf8"))).toEqual(["--message", "fix & ship"])
    expect((await cmd("aider", { env: tab("3") })).code).toBe(3)
    expect(deliveredSince(before).map((row) => [row.provider, JSON.parse(row.providerEvent ?? "").hook_event_name])).toEqual([
      ["aider", "Busy"],
      ["aider", "Idle"],
      ["aider", "Busy"],
      ["aider", "Error"],
    ])

    const missing = await cmd("aider", { env: env() })
    expect(missing.code).toBe(127)
    expect(missing.stderr).toContain("Claxedo: aider not found in PATH")
  })

  test("the Claude wrapper starts Claude with Claxedo's settings and settles the tab when Claude exits", async () => {
    const { dir, argv } = await fakeCli("claude")
    const before = deliveries.length
    const ran = await cmd('claude -p "say hi"', {
      env: env({ PATH: `${manifest.dirs.bin};${dir};${env().PATH}`, FAKE_ARGV: argv, FAKE_EXIT: "2" }),
    })
    expect(ran.code).toBe(2)
    expect(JSON.parse(await fs.readFile(argv, "utf8"))).toEqual([
      "--settings",
      path.join(manifest.dirs.hooks, "claude-settings.json"),
      "-p",
      "say hi",
    ])
    expect(deliveredSince(before).map((row) => [row.provider, JSON.parse(row.providerEvent ?? "")])).toEqual([
      ["claude", { hook_event_name: "Error" }],
    ])
  })

  test("Cursor's merged hook command answers Cursor and forwards the event, as Cursor runs it through cmd.exe", async () => {
    const home = path.join(root, "cursor-run-home")
    await materializeAgentHooks({ homeDir: home, notifyPath: manifest.files.notify, templates: defaultStatusHooks, platform: "windows" })
    const hooks = (JSON.parse(await fs.readFile(path.join(home, ".cursor", "hooks.json"), "utf8")) as {
      hooks: Record<string, { command: string }[]>
    }).hooks
    const event = '{"hook_event_name":"beforeShellExecution","conversation_id":"c-1"}'

    const before = deliveries.length
    const asked = await cmd(hooks.beforeShellExecution[0].command, { env: env(), stdin: event })
    expect(asked).toEqual({ code: 0, stdout: '{"continue":true}\r\n', stderr: "" })
    const stopped = await cmd(hooks.stop[0].command, { env: env(), stdin: '{"hook_event_name":"stop"}' })
    expect(stopped.stdout).toBe("{}\r\n")
    const outside = await cmd(hooks.stop[0].command, { env: env({ CLAXEDO_TAB_ID: undefined }), stdin: event })
    expect(outside).toEqual({ code: 0, stdout: "{}\r\n", stderr: "" })
    expect(deliveredSince(before).map((row) => [row.provider, row.providerEvent])).toEqual([
      ["cursor", event],
      ["cursor", '{"hook_event_name":"stop"}'],
    ])
  })
})
