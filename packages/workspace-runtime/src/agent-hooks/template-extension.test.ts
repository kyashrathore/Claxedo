import { readStatusHookTemplates, type StatusHookTemplate } from "@claxedo/plugin-api"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createStatusHooksManifest, writeStatusHooksArtifacts } from "./core/setup"
import { materializeAgentHooks } from "./materialize-status-hooks"
import { providerLifecycle } from "./provider-lifecycle"

const declaration: StatusHookTemplate = {
  command: "new-agent",
  provider: "new-agent",
  aliases: [],
  artifacts: [],
  install: {
    type: "config-merge",
    path: "~/.new-agent/hooks.json",
    base: ["hooks"],
    shape: "flat",
    entries: { TurnOpened: { command: "{{notify|sh}} --harness=new-agent" } },
    managedScript: "notify.sh",
  },
  events: { TurnOpened: "running", Approval: "waiting", Finished: "done", Heartbeat: "ignored" },
  subagent: ["worker_id"],
}
const [template] = readStatusHookTemplates([declaration])

test("an injected template installs its wrapper and config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "new-status-hook-"))
  try {
    const manifest = createStatusHooksManifest(path.join(root, "data"))
    await writeStatusHooksArtifacts(manifest, { templates: [template] })
    expect(await fs.readFile(path.join(manifest.dirs.bin, "new-agent"), "utf8")).toContain(
      'find_real_binary "new-agent"',
    )
    await materializeAgentHooks({ homeDir: root, notifyPath: manifest.files.notify, templates: [template] })
    expect(JSON.parse(await fs.readFile(path.join(root, ".new-agent/hooks.json"), "utf8"))).toEqual({
      hooks: { TurnOpened: [{ command: `'${manifest.files.notify}' --harness=new-agent` }] },
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test("an injected template maps new events and uses its own subagent field", () => {
  const map = (input: Record<string, unknown>) => providerLifecycle(input, [template])
  expect(map({ provider: "new-agent", hook_event_name: "TurnOpened" })).toMatchObject({ eventType: "Busy" })
  expect(map({ provider: "new-agent", hook_event_name: "Approval", worker_id: "child" })).toMatchObject({
    eventType: "UserActionRequired",
    subagent: true,
  })
  expect(map({ provider: "new-agent", hook_event_name: "Finished" })).toMatchObject({ eventType: "Idle" })
  expect(map({ provider: "new-agent", hook_event_name: "Heartbeat" })).toBeUndefined()
  expect(map({ provider: "new-agent", hook_event_name: "Finished", worker_id: "child" })).toBeUndefined()
})

test("an injected project-file template installs and excludes its own hook file when its wrapper runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-project-hook-"))
  try {
    const project = path.join(root, "project"),
      real = path.join(root, "real")
    await fs.mkdir(path.join(project, ".git/info"), { recursive: true })
    await fs.writeFile(path.join(project, ".git/info/exclude"), "build/")
    await fs.mkdir(real)
    await fs.writeFile(path.join(real, "project-agent"), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const definition: StatusHookTemplate = {
      ...template,
      command: "project-agent",
      provider: "project-agent",
      install: {
        type: "project-file",
        path: ".hooks/plugin.json",
        hookFile: "plugin-hook.sh",
        entries: { version: 1, hooks: { Begin: [{ command: "{{plugin-hook.sh|sh}}" }] } },
      },
      artifacts: [{ file: "plugin-hook.sh", content: "#!/bin/bash\nexit 0\n", mode: 0o755 }],
    }
    const manifest = createStatusHooksManifest(path.join(root, "data"))
    await writeStatusHooksArtifacts(manifest, { templates: [definition] })
    const child = Bun.spawn([path.join(manifest.dirs.bin, "project-agent"), "unchanged"], {
      cwd: project,
      env: { ...process.env, PATH: real + ":" + process.env.PATH, CLAXEDO_TAB_ID: "tab" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("unchanged\n")
    expect(JSON.parse(await fs.readFile(path.join(project, ".hooks/plugin.json"), "utf8"))).toEqual({
      version: 1,
      hooks: { Begin: [{ command: `'${manifest.dirs.hooks}/plugin-hook.sh'` }] },
    })
    expect(await fs.readFile(path.join(project, ".git/info/exclude"), "utf8")).toBe("build/\n.hooks/plugin.json\n")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
