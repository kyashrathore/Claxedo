import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { openIn, type OpenInEffects } from "./open-in"

const platform = process.platform
const deps = { platform, resolveAppPath: async () => null }

let root = ""
const at = (name: string) => path.join(root, name)

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "open-in-"))
  mkdirSync(at("project"))
  writeFileSync(at("notes.md"), "# notes\n")
  writeFileSync(at("run.command"), "#!/bin/sh\necho pwned\n")
  writeFileSync(at("run.ps1"), "Write-Host pwned\n")
  writeFileSync(at("tool"), "#!/bin/sh\necho pwned\n")
  chmodSync(at("tool"), 0o755)
  mkdirSync(at("Evil.app"))
  symlinkSync(at("run.command"), at("link-to-script"))
  symlinkSync(at("run.command"), at("decoy.md"))
  symlinkSync(at("tool"), at("link-to-tool"))
  symlinkSync(at("project"), at("link-to-project"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type Call = { effect: keyof OpenInEffects; args: string[] }

function recorder(confirm: boolean) {
  const calls: Call[] = []
  const effects: OpenInEffects = {
    reveal: (target) => {
      calls.push({ effect: "reveal", args: [target] })
    },
    openWithOsHandler: async (target) => {
      calls.push({ effect: "openWithOsHandler", args: [target] })
    },
    confirmOpenExecutable: async (target) => {
      calls.push({ effect: "confirmOpenExecutable", args: [target] })
      return confirm
    },
    launch: async (app, target) => {
      calls.push({ effect: "launch", args: [app, target] })
    },
  }
  return { calls, effects }
}

describe("open-path without an app", () => {
  test("a document opens through the OS handler", async () => {
    const { calls, effects } = recorder(false)
    await openIn({ path: at("notes.md") }, deps, effects)
    expect(calls).toEqual([{ effect: "openWithOsHandler", args: [at("notes.md")] }])
  })

  test("a directory is revealed, never handed to an OS handler", async () => {
    const { calls, effects } = recorder(false)
    await openIn({ path: at("project") }, deps, effects)
    expect(calls).toEqual([{ effect: "reveal", args: [at("project")] }])
  })

  test.each(["run.command", "run.ps1", "tool", "link-to-script", "decoy.md", "link-to-tool", "Evil.app"])(
    "%s asks the user first and opens nothing when they decline",
    async (name) => {
      const { calls, effects } = recorder(false)
      await openIn({ path: at(name) }, deps, effects)
      expect(calls).toEqual([{ effect: "confirmOpenExecutable", args: [at(name)] }])
    },
  )

  test("a confirmed executable opens through the OS handler", async () => {
    const { calls, effects } = recorder(true)
    await openIn({ path: at("run.command") }, deps, effects)
    expect(calls.map((call) => call.effect)).toEqual(["confirmOpenExecutable", "openWithOsHandler"])
  })

  test("a path that does not exist is refused before any effect", async () => {
    const { calls, effects } = recorder(true)
    await expect(openIn({ path: at("missing.md") }, deps, effects)).rejects.toThrow(/rejected/)
    expect(calls).toEqual([])
  })
})

describe("open-path in a terminal", () => {
  test("a directory opens in Terminal", async () => {
    const { calls, effects } = recorder(false)
    await openIn({ path: at("project"), app: "Terminal" }, deps, effects)
    expect(calls).toEqual([{ effect: "launch", args: ["Terminal", at("project")] }])
  })

  test("a symlink to a directory still opens in Terminal", async () => {
    const { calls, effects } = recorder(false)
    await openIn({ path: at("link-to-project"), app: "Terminal" }, deps, effects)
    expect(calls).toEqual([{ effect: "launch", args: ["Terminal", at("link-to-project")] }])
  })

  test.each([
    ["run.command", "Terminal"],
    ["run.ps1", "powershell"],
    ["tool", "iTerm"],
    ["link-to-script", "Ghostty"],
    ["decoy.md", "Terminal"],
    ["notes.md", "Warp"],
    ["Evil.app", "Terminal"],
  ])("%s is refused for %s without launching anything", async (name, app) => {
    const { calls, effects } = recorder(true)
    await expect(openIn({ path: at(name), app }, deps, effects)).rejects.toThrow(/rejected/)
    expect(calls).toEqual([])
  })
})

describe("open-path in an editor", () => {
  test("an editor takes a file", async () => {
    const { calls, effects } = recorder(false)
    await openIn({ path: at("run.command"), app: "Visual Studio Code" }, deps, effects)
    expect(calls).toEqual([{ effect: "launch", args: ["Visual Studio Code", at("run.command")] }])
  })

  test("an app off the allowlist is refused without launching anything", async () => {
    const { calls, effects } = recorder(true)
    await expect(openIn({ path: at("project"), app: "/bin/sh" }, deps, effects)).rejects.toThrow(/allowlist/)
    expect(calls).toEqual([])
  })
})

describe("open-path handler wiring", () => {
  // The handler cannot be imported here — `ipc.ts` imports electron — so the
  // one fact these tests cannot see is read off the source: that every OS call
  // the channel can make is bound as an effect of this decision, and none of
  // them is reachable around it.
  const source = readFileSync(path.join(import.meta.dir, "ipc.ts"), "utf8")
  const handler = source.slice(
    source.indexOf('ipcMain.handle("open-path"'),
    source.indexOf('ipcMain.handle("show-item-in-folder"'),
  )

  test("every OS call sits behind the decision", () => {
    const decide = handler.indexOf("openIn(")
    expect(decide).toBeGreaterThan(-1)
    for (const call of ["shell.showItemInFolder(", "shell.openPath(", "confirmOpenExecutable(", "execFile("]) {
      expect(handler.indexOf(call)).toBeGreaterThan(decide)
    }
  })

  test("the confirmation is a native dialog, not a renderer prompt", () => {
    const confirm = source.slice(source.indexOf("async function confirmOpenExecutable"))
    expect(confirm).toContain("dialog.showMessageBox")
  })
})
