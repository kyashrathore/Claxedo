import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { installArgvRecordingShim, installUnresolvableShim } from "../../test-utils/windows-argv-recorder"
import { createStdioACPTransport, type ACPTransportFactoryInput } from "./transport"

const ARGS = ["x&y", "%PATH%", "a|b", "^c", '"q"', "has space", "--flag=<>", "'single'"]

type Exit = { code: number | null; signal: NodeJS.Signals | null }

function launch(input: Pick<ACPTransportFactoryInput, "command" | "directory"> & Partial<ACPTransportFactoryInput>) {
  const stderr: string[] = []
  let settle!: (exit: Exit) => void
  let fail!: (error: Error) => void
  const exited = new Promise<Exit>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const transport = createStdioACPTransport({
    args: ARGS,
    model: "acceptance",
    env: {},
    onStderr: (text) => stderr.push(text),
    onExit: (code, signal) => settle({ code, signal }),
    onError: fail,
    ...input,
  })
  return { transport, exited, stderr }
}

async function awaitExit(launched: ReturnType<typeof launch>, timeoutMs = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      launched.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`recorder did not exit within ${timeoutMs}ms; stderr: ${launched.stderr.join("\n")}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform !== "win32")("createStdioACPTransport through a real .cmd launcher on native Windows", () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  test("a launcher in a path with a space delivers every argument literally, with no shell in between", async () => {
    const shim = installArgvRecordingShim("agent")
    cleanups.push(shim.remove)

    const launched = launch({ command: shim.shim, directory: shim.dir, env: shim.env })
    try {
      const exit = await awaitExit(launched)
      expect(exit, launched.stderr.join("\n")).toEqual({ code: 0, signal: null })
      expect(shim.read()).toEqual({ execPath: process.execPath, argv: ARGS })
      expect(launched.transport.metadata.command).toBe(shim.shim)
    } finally {
      await launched.transport.dispose()
    }
  })

  test("a bare launcher name resolves through the configured PATH from an unrelated directory", async () => {
    const shim = installArgvRecordingShim("agent")
    cleanups.push(shim.remove)
    const directory = mkdtempSync(path.join(tmpdir(), "acceptance cwd-"))
    cleanups.push(() => removeTestTempDir(directory))
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"

    const launched = launch({
      command: "agent.cmd",
      directory,
      env: { ...shim.env, [pathKey]: `${shim.dir};${process.env[pathKey] ?? ""}` },
    })
    try {
      const exit = await awaitExit(launched)
      expect(exit, launched.stderr.join("\n")).toEqual({ code: 0, signal: null })
      expect(shim.read()).toEqual({ execPath: process.execPath, argv: ARGS })
    } finally {
      await launched.transport.dispose()
    }
  })

  test("a launcher that names no executable is refused before anything runs", async () => {
    const shim = installUnresolvableShim("agent")
    cleanups.push(shim.remove)

    expect(() => launch({ command: shim.shim, directory: shim.dir })).toThrow("does not resolve to a real executable")
    await sleep(300)
    expect(existsSync(shim.marker), "the shim body ran, so a shell executed it").toBe(false)
  })
})
