import { execFile, spawn } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

type Restoration = "restored" | "superseded"

/** The native child retains every pasteboard representation; no original clipboard data crosses its stdout. */
export async function installNativeClipboardImage(pngPath: string): Promise<{ close(): Promise<Restoration> }> {
  if (process.platform !== "darwin") throw new Error("GATING: native clipboard preservation requires macOS")
  const fixture = await realpath(pngPath)
  const scratch = await mkdtemp(path.join(tmpdir(), "claxedo-e2e-clipboard-"))
  const executable = path.join(scratch, "clipboard")
  try {
    await promisify(execFile)("/usr/bin/xcrun", [
      "swiftc", path.join(import.meta.dirname, "native-clipboard.swift"), "-o", executable,
    ], { timeout: 60_000 })
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    throw error
  }

  const child = spawn(executable, [fixture], { stdio: ["pipe", "pipe", "ignore"] })
  const lines = createInterface({ input: child.stdout })
  let outcome: Restoration | undefined
  let failure: Error | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const completed = new Promise<void>((resolve) => {
    child.once("error", () => {
      failure = new Error("Native clipboard helper could not start")
      rejectReady(failure)
    })
    child.once("close", (code) => {
      lines.close()
      if (code !== 0 || !outcome) failure ??= new Error("Native clipboard helper exited without restoration acknowledgement")
      rejectReady(failure ?? new Error("Native clipboard helper exited before installation"))
      resolve()
    })
  })
  lines.on("line", (line) => {
    if (line === "installed") resolveReady()
    else if (line === "restored" || line === "superseded") outcome = line
    else {
      failure = new Error("Native clipboard helper rejected installation or restoration")
      rejectReady(failure)
    }
  })
  child.stdin.on("error", () => { /* Process completion reports a broken helper without logging clipboard data. */ })
  let closing: Promise<Restoration> | undefined
  const close = () => closing ??= (async () => {
    child.stdin.end()
    const deadline = setTimeout(() => {
      failure = new Error("Native clipboard cleanup timed out; restoration is unverified")
      child.kill("SIGKILL")
    }, 10_000)
    try {
      await completed
      if (failure) throw failure
      return outcome!
    } finally {
      clearTimeout(deadline)
      await rm(scratch, { recursive: true, force: true })
    }
  })()
  const deadline = setTimeout(() => rejectReady(new Error("Native clipboard installation timed out")), 15_000)
  try {
    await ready
    return { close }
  } catch (error) {
    await close()
    throw error
  } finally {
    clearTimeout(deadline)
  }
}
