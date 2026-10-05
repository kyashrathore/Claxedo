import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import os from "node:os"
import { spawnLaunchGate } from "@claxedo/process-ownership/launch"

await test("an activation sent to a gate that already died fails with the gate's exit, not the send's EPIPE", { skip: process.platform === "win32" }, async () => {
  const handle = spawnLaunchGate({ cwd: os.tmpdir(), env: process.env, activationDeadlineMs: 30_000 })
  const { identity, gateNonce } = await handle.reported
  process.kill(-identity.processGroupId, "SIGKILL")
  for (let wait = 0; !defunct(identity.pid); wait++) {
    assert.ok(wait < 400, "the killed gate never became defunct")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  handle.activate(gateNonce, { command: "/bin/sh", args: ["-c", "true"] })
  const failure = await handle.acknowledged.then(() => undefined, (error) => error)
  assert.match(String(failure?.message), /^Launch gate exited \(code null, signal SIGKILL\)/)
})

function defunct(pid) {
  return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z")
}
