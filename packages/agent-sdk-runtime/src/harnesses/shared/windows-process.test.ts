import { expect, spyOn, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { drainHarnessProcessGroup } from "./windows-process"

const denied = () => Object.assign(new Error("permission denied"), { code: "EPERM" })
const missing = () => Object.assign(new Error("no such group"), { code: "ESRCH" })

test.skipIf(process.platform === "win32")("a transient Darwin zombie-group EPERM still waits for authoritative group absence", async () => {
  let inspections = 0
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) throw denied()
    if (++inspections < 3) throw denied()
    throw missing()
  })
  try {
    await drainHarnessProcessGroup({ pid: 987654 } as ChildProcess, 100)
    expect(inspections).toBe(3)
  } finally { kill.mockRestore() }
})

test.skipIf(process.platform === "win32")("persistent group EPERM never counts as successful retirement", async () => {
  const kill = spyOn(process, "kill").mockImplementation(() => { throw denied() })
  try {
    await expect(drainHarnessProcessGroup({ pid: 987654 } as ChildProcess, 20)).rejects.toThrow("did not terminate: permission denied")
  } finally { kill.mockRestore() }
})
