import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { readCreationIdentity } from "./identity"
import { launchOwnedProcess } from "./launch-gate"
import { volatileLaunchOwnership } from "./volatile-ownership"
import { containInWindowsJob, createWindowsJobs } from "./windows-job"

const windows = process.platform === "win32"

// Stands in for the PowerShell program: answers in order, one line per request.
const interpreter = `
const { createInterface } = require("node:readline")
const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const [, pid] = line.split(" ")
  const answers = { "100": "contained", "200": "absent", "300": "mismatch 2026-10-11T04:00:00.0000000Z", "400": "error Access is denied. (Windows error 5)" }
  process.stdout.write((answers[pid] ?? "contained but differently") + "\\n")
})`

function jobs() {
  return createWindowsJobs({ launch: () => spawn(process.execPath, ["-e", interpreter], { stdio: ["pipe", "pipe", "pipe"] }) })
}

const created = "2026-10-11T03:59:59.1234560Z"

test("each answer the program writes settles its own request", async () => {
  const helper = jobs()
  expect(await helper.contain({ pid: 100, startSecond: created }, 15_000)).toBe("contained")
  expect(await helper.contain({ pid: 200, startSecond: created }, 15_000)).toBe("exited")
  await expect(helper.contain({ pid: 300, startSecond: created }, 15_000)).rejects.toThrow("pid 300 is now a process created at 2026-10-11T04:00:00.0000000Z")
  await expect(helper.contain({ pid: 400, startSecond: created }, 15_000)).rejects.toThrow("Access is denied. (Windows error 5)")
  await expect(helper.contain({ pid: 500, startSecond: created }, 15_000)).rejects.toThrow("unexpected form")
}, 60_000)

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const item of cleanup.splice(0)) await item()
})

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "windows-job-"))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

async function pidIn(file: string) {
  let pid = 0
  await until(async () => {
    pid = Number(await fs.readFile(file, "utf8").catch(() => "0"))
    return pid > 0
  }, 10_000)
  if (!pid) throw new Error(`${file} never named a pid`)
  cleanup.push(() => { if (alive(pid)) process.kill(pid, "SIGKILL") })
  return pid
}

/**
 * A detached process whose own launcher exits right after starting it: nothing
 * in the live process table connects it to the launch any more.
 */
function orphanMaker(directory: string) {
  const orphan = `require("node:fs").writeFileSync(${JSON.stringify(path.join(directory, "orphan.pid"))}, String(process.pid)); setInterval(() => {}, 1000)`
  const launcher = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(orphan)}], { detached: true, stdio: "ignore" }).unref()`
  return `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(launcher)}], { detached: true, stdio: "ignore" }).unref()`
}

test.skipIf(!windows)("retiring a contained launch ends an orphan its launcher left behind", async () => {
  const directory = await workspace()
  const launch = await launchOwnedProcess({
    ownership: volatileLaunchOwnership(),
    role: "harness",
    payload: { command: process.execPath, args: ["-e", `${orphanMaker(directory)}; setInterval(() => {}, 1000)`] },
    cwd: directory,
    env: process.env,
  })
  const orphan = await pidIn(path.join(directory, "orphan.pid"))
  expect((await readCreationIdentity(orphan))?.parentPid).not.toBe(launch.payloadPid)

  const result = await launch.retire({ termGraceMs: 2_000, killVerifyMs: 2_000 })

  expect(result.leader).toBe("exited")
  expect(await until(() => !alive(orphan), 5_000)).toBe(true)
}, 60_000)

test.skipIf(!windows)("a contained launch whose leader exits on its own leaves nothing it started running", async () => {
  const directory = await workspace()
  const launch = await launchOwnedProcess({
    ownership: volatileLaunchOwnership(),
    role: "harness",
    payload: {
      command: process.execPath,
      args: ["-e", `${orphanMaker(directory)}; const fs = require("node:fs"); const file = ${JSON.stringify(path.join(directory, "orphan.pid"))}; const wait = setInterval(() => { if (fs.existsSync(file)) { clearInterval(wait); process.exit(0) } }, 25)`],
    },
    cwd: directory,
    env: process.env,
  })
  const orphan = await pidIn(path.join(directory, "orphan.pid"))

  expect(await until(() => launch.child.exitCode !== null, 10_000)).toBe(true)
  expect(await until(() => !alive(orphan), 5_000)).toBe(true)
}, 60_000)

test.skipIf(!windows)("containment refuses a pid whose creation time is not the recorded one, and reports one that is gone", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  cleanup.push(() => { child.kill() })
  const identity = await readCreationIdentity(child.pid!)
  if (!identity) throw new Error("the child's identity could not be read")

  await expect(containInWindowsJob({ ...identity, startSecond: "2001-01-01T00:00:00.0000000Z" })).rejects.toThrow(`pid ${identity.pid} is now a process created at`)

  child.kill()
  await new Promise((resolve) => child.once("exit", resolve))
  expect(await containInWindowsJob(identity)).toBe("exited")
}, 60_000)
