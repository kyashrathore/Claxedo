import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GATE_EXIT, launchOwnedProcess } from "./launch-gate"
import { LaunchRefusedError, type PreparedLaunch } from "./ownership-store"
import { volatileLaunchOwnership } from "./volatile-ownership"

test("a gate that exits without creation identity retires its reservation without authorizing a payload", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "missing-identity-"))
  const originalGate = process.env.CLAXEDO_LAUNCH_GATE_CHILD
  const failedGate = path.join(directory, "identity-unavailable.mjs")
  await fs.writeFile(failedGate, `process.exit(${GATE_EXIT.identityUnavailable})\n`)
  const ownership = volatileLaunchOwnership()
  const prepared: PreparedLaunch[] = []
  const input = { ownership: { ...ownership, async prepare(input: Parameters<typeof ownership.prepare>[0]) {
    const launch = await ownership.prepare(input)
    prepared.push(launch)
    return launch
  } }, role: "harness" as const, scope: { directory }, cwd: directory, env: process.env,
    payload: { command: process.execPath, args: ["-e", "process.stdout.write('payload ran')"] } }
  try {
    process.env.CLAXEDO_LAUNCH_GATE_CHILD = failedGate
    await expect(launchOwnedProcess(input)).rejects.toBeInstanceOf(LaunchRefusedError)
    expect(prepared).toHaveLength(1)
    const record = await ownership.read(prepared[0].launchId)
    expect(record?.identity).toBeUndefined()
    expect(record?.activationAuthorizedAt).toBeUndefined()
    expect(record?.activationAcknowledgedAt).toBeUndefined()
    expect(record?.cleanup).toEqual({ leader: "exited", descendants: "verified_clear", signals: [] })
    expect(record?.retiredAt).toBeGreaterThan(0)
    expect(await ownership.listUnresolved({ kind: "standalone", directory })).toEqual([])
  } finally {
    restoreGate(originalGate)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)

function restoreGate(value: string | undefined) {
  if (value === undefined) delete process.env.CLAXEDO_LAUNCH_GATE_CHILD
  else process.env.CLAXEDO_LAUNCH_GATE_CHILD = value
}
