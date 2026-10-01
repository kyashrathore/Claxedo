import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { defaultStatusHooks } from "../../../workspace-runtime/src/status-hooks"
import { generateNotifyScript } from "../../../workspace-runtime/src/agent-hooks/core/hooks"
import { hookArtifact } from "../../../workspace-runtime/src/agent-hooks/core/render"
import { generateTemplateWrapper } from "../../../workspace-runtime/src/agent-hooks/core/wrappers"
import { materializeAgentHooks } from "../../../workspace-runtime/src/agent-hooks/materialize-status-hooks"
import { AgentHookRoutes } from "../../../workspace-runtime/src/routes/agent-hook"
import { Pty } from "../../../workspace-runtime/src/pty/index"
import { startScriptedCursorBackend } from "./cursor/backend"
import { PINNED_CODEX } from "./pinned-codex"
import { releasePort, reservePort } from "./ports"
import { startScriptedModelServer } from "./scripted-model-server"

type Observation = { terminalId: string; event: string; agentId?: string; state?: string }

const terminals = new Set<string>()
const pty = spyOn(Pty, "get").mockImplementation((id) => id && terminals.has(id)
  ? { id, title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running" as const, pid: 4_194_305 }
  : undefined)
const routes = AgentHookRoutes()
const observations: Observation[] = []
let root: string
let lifecycle: http.Server
let lifecyclePort: number

async function tabState(terminalId: string): Promise<string | undefined> {
  const response = await routes.request(`http://localhost/terminal-session?terminalId=${terminalId}`)
  return response.ok ? (await response.json() as { session?: { eventType?: string } }).session?.eventType : undefined
}

async function snapshot(folder: string): Promise<Record<string, string>> {
  const rows: Record<string, string> = {}
  for (const name of (await fs.readdir(folder, { recursive: true })).sort()) {
    const file = path.join(folder, name)
    if ((await fs.stat(file)).isFile()) rows[name] = createHash("sha256").update(await fs.readFile(file)).digest("hex")
  }
  return rows
}

function run(file: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk })
  child.stderr.on("data", (chunk: Buffer) => { output += chunk })
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, output }))
  })
}

async function until(label: string, done: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(observations)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function tabEnv(home: string, terminalId: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CLAXEDO_TAB_ID: terminalId,
    CLAXEDO_TERMINAL_ID: terminalId,
    CLAXEDO_SERVER_PORT: String(lifecyclePort),
    WORKSPACE_RUNTIME_STATE_DIR: path.join(root, "state"),
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-status-"))
  lifecyclePort = await reservePort()
  lifecycle = http.createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString("utf8")
      const form = new URLSearchParams(body)
      const response = await routes.request("http://localhost/agent-lifecycle", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      })
      const event = JSON.parse(form.get("providerEvent") ?? "{}") as { hook_event_name?: string; agent_id?: string }
      const terminalId = form.get("terminalId") ?? ""
      observations.push({ terminalId, event: event.hook_event_name ?? "", ...(event.agent_id ? { agentId: event.agent_id } : {}), state: await tabState(terminalId) })
      outgoing.writeHead(response.status, { "content-type": "application/json" }).end(await response.text())
    })()
  })
  await new Promise<void>((resolve) => lifecycle.listen(lifecyclePort, "127.0.0.1", resolve))
})

afterAll(async () => {
  pty.mockRestore()
  await new Promise<void>((resolve) => lifecycle.close(() => resolve()))
  releasePort(lifecyclePort)
  await fs.rm(root, { recursive: true, force: true })
})

test("a real Codex run in a tab reports busy, waiting and done through session-flag hooks, a subagent never settles it, and ~/.codex is untouched", async () => {
  const modelPort = await reservePort()
  const model = await startScriptedModelServer({ port: modelPort, red: false })
  const home = path.join(root, "codex-person")
  const personal = path.join(home, ".codex")
  const work = path.join(root, "codex-work")
  await fs.mkdir(personal, { recursive: true })
  await fs.mkdir(work, { recursive: true })
  await fs.writeFile(path.join(personal, "config.toml"), [
    "check_for_update_on_startup = false", 'model = "gpt-4.1"', 'model_provider = "scripted"', "[model_providers.scripted]",
    'name = "scripted"', `base_url = "${model.v1Url}"`, 'wire_api = "responses"', "requires_openai_auth = false",
    'http_headers = { Authorization = "Bearer terminal-status" }', "",
  ].join("\n"))
  await fs.writeFile(path.join(personal, "AGENTS.md"), "Person's instructions\n")
  const before = await snapshot(personal)
  const notify = path.join(root, "hooks", "notify.sh")
  await fs.mkdir(path.dirname(notify), { recursive: true })
  await fs.writeFile(notify, generateNotifyScript(lifecyclePort, defaultStatusHooks), { mode: 0o755 })
  const wrapper = path.join(root, "claxedo-bin", "codex")
  await fs.mkdir(path.dirname(wrapper), { recursive: true })
  await fs.writeFile(wrapper, generateTemplateWrapper(defaultStatusHooks.find((template) => template.command === "codex")!, notify), { mode: 0o755 })
  const codexBin = path.dirname(PINNED_CODEX)
  const terminalId = "codex-tab"
  terminals.add(terminalId)
  model.scriptToolSequence("CODEXTAB", [
    { name: "request_user_input", input: { questions: [{ id: "q1", header: "Pick", question: "Which one?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] } },
    { name: "spawn_agent", namespace: "multi_agent_v1", input: { message: "CHILDTASK reply done" } },
  ])
  model.scriptText({ marker: "CHILDTASK", text: "child done" })
  const release = model.holdTextReplies("CODEXTAB")
  try {
    const running = run("bash", [wrapper, "exec", "--skip-git-repo-check", "CODEXTAB finish the task"], {
      cwd: work, env: { ...tabEnv(home, terminalId), PATH: `${codexBin}:${process.env.PATH ?? ""}` },
    })
    const tab = () => observations.filter((row) => row.terminalId === terminalId)
    await until("the subagent's SubagentStop", () => tab().some((row) => row.agentId && row.event === "SubagentStop"))
    expect(tab().filter((row) => row.agentId).map((row) => row.event)).toEqual(expect.arrayContaining(["SubagentStart", "UserPromptSubmit", "SubagentStop"]))
    expect(await tabState(terminalId)).not.toBe("Idle")
    release()
    const finished = await running
    expect(finished.code).toBe(0)
    await until("the parent's Stop", () => tab().some((row) => row.event === "Stop" && !row.agentId))
    const states = tab().map((row) => `${row.event}${row.agentId ? "(child)" : ""}:${row.state}`)
    expect(states).toContain("UserPromptSubmit:Busy")
    expect(states).toContain("PreToolUse:UserActionRequired")
    const parentStop = tab().findIndex((row) => row.event === "Stop" && !row.agentId)
    expect(tab().slice(0, parentStop).some((row) => row.state === "Idle")).toBe(false)
    expect(tab()[parentStop].state).toBe("Idle")
    expect(await snapshot(personal)).toMatchObject(before)
    await expect(fs.stat(path.join(personal, "hooks.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await fs.readFile(path.join(personal, "config.toml"), "utf8")).not.toContain("hooks")
  } finally {
    release()
    await model.close()
    releasePort(modelPort)
  }
}, 120_000)

test("a real Cursor agent in a tab reaches the lifecycle route through Claxedo's merged ~/.cursor/hooks.json entries", async () => {
  const backendPort = await reservePort()
  const backend = await startScriptedCursorBackend(backendPort)
  const home = path.join(root, "cursor-person")
  const personal = path.join(home, ".cursor", "hooks.json")
  const work = path.join(root, "cursor-work")
  await fs.mkdir(path.dirname(personal), { recursive: true })
  await fs.mkdir(work, { recursive: true })
  const personHooks = '{\n  "version": 1,\n  "hooks": { "afterFileEdit": [ { "command": "true" } ] }\n}\n'
  await fs.writeFile(personal, personHooks)
  const hookDir = path.join(root, "cursor-hooks")
  await fs.mkdir(hookDir, { recursive: true })
  const notify = path.join(hookDir, "notify.sh")
  const cursorHook = path.join(hookDir, "cursor-hook.sh")
  await fs.writeFile(notify, generateNotifyScript(lifecyclePort, defaultStatusHooks), { mode: 0o755 })
  await fs.writeFile(cursorHook, hookArtifact(defaultStatusHooks.find((template) => template.command === "cursor")!, "cursor-hook.sh", notify), { mode: 0o755 })
  const merge = () => materializeAgentHooks({ homeDir: home, notifyPath: notify, templates: defaultStatusHooks })
  expect((await merge()).find((result) => result.runner === "cursor")?.status).toBe("applied")
  const merged = await fs.readFile(personal, "utf8")
  expect(merged).toContain('"afterFileEdit": [ { "command": "true" } ]')
  await merge()
  expect(await fs.readFile(personal, "utf8")).toBe(merged)
  const terminalId = "cursor-tab"
  terminals.add(terminalId)
  backend.script("cursortab", { steps: [{ kind: "text", text: "cursor done" }], usage: { inputTokens: 1, outputTokens: 1 } })
  try {
    const finished = await run("bun", [path.join(import.meta.dirname, "cursor-local-run.ts"), "CURSOR_SCRIPT:cursortab", work], {
      cwd: path.join(import.meta.dirname, ".."), env: { ...tabEnv(home, terminalId), CURSOR_BACKEND_URL: backend.url },
    })
    expect(finished.output).toContain('"status":"finished"')
    const tab = () => observations.filter((row) => row.terminalId === terminalId)
    await until("Cursor's stop hook", () => tab().some((row) => row.event === "stop"))
    expect(tab().map((row) => `${row.event}:${row.state}`)).toEqual(expect.arrayContaining(["beforeSubmitPrompt:Busy", "stop:Idle"]))

    const delivered = observations.length
    const outside = await run("bun", [path.join(import.meta.dirname, "cursor-local-run.ts"), "CURSOR_SCRIPT:cursortab", work], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAXEDO_SERVER_PORT: String(lifecyclePort), CURSOR_BACKEND_URL: backend.url },
    })
    expect(outside.output).toContain('"status":"finished"')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(observations.length).toBe(delivered)
    expect(await fs.readFile(personal, "utf8")).toBe(merged)
  } finally {
    await backend.close()
    releasePort(backendPort)
  }
}, 120_000)
