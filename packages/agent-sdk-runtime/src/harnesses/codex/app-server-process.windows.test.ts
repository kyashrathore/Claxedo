import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { installArgvRecordingShim, installUnresolvableShim } from "../../test-utils/windows-argv-recorder"
import { volatileLaunchOwnership } from "../../launch"
import { CodexAppServerProcess } from "./app-server-process"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform !== "win32")("CodexAppServerProcess through a real codex.cmd launcher on native Windows", () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  test("the app-server argv reaches the wrapped script literally under this runtime, not under cmd.exe's node", async () => {
    const shim = installArgvRecordingShim("codex", { serve: true })
    cleanups.push(shim.remove)

    const server = await CodexAppServerProcess.start({
      binary: shim.shim,
      directory: shim.dir,
      env: { ...process.env, ...shim.env },
      requestHandler: async () => ({}),
      ownership: volatileLaunchOwnership(),
    })
    try {
      expect(shim.read()).toEqual({ execPath: process.execPath, argv: ["app-server", "--listen", "stdio://"] })
    } finally {
      await server.dispose()
    }
  }, 15_000)

  test("a launcher that names no executable is refused before anything runs", async () => {
    const shim = installUnresolvableShim("codex")
    cleanups.push(shim.remove)

    await expect(CodexAppServerProcess.start({
      binary: shim.shim,
      directory: shim.dir,
      env: process.env,
      requestHandler: async () => ({}),
      ownership: volatileLaunchOwnership(),
    })).rejects.toThrow("does not resolve to a real executable")
    await sleep(300)
    expect(existsSync(shim.marker), "the shim body ran, so a shell executed it").toBe(false)
  })
})
