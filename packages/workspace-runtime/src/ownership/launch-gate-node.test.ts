/**
 * The gate under a Node host, spawned the way production spawns it: with the
 * payload's working directory, not the runtime's. Bun runs TypeScript directly
 * and never exercises the loader path, so this leg is the only place a
 * resolution that depends on the child's cwd shows up.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import {
  GATE_EXIT,
  resolveLaunchGateChild,
  spawnLaunchGate,
  volatileLaunchOwnership,
  launchOwnedProcess,
  LaunchRefusedError,
} from "@claxedo/agent-sdk-runtime/launch"

const scratch: string[] = []
afterEach(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function elsewhere() {
  const directory = await mkdtemp(path.join(tmpdir(), "launch-gate-node-"))
  scratch.push(directory)
  return directory
}

void test("the gate this host resolves is one this host can actually run", () => {
  const entry = resolveLaunchGateChild()
  assert.ok(entry.file.endsWith(".mjs") || entry.runner.length > 0,
    `a Node host cannot execute ${entry.file} with runner ${JSON.stringify(entry.runner)}`)
  // A bare specifier here resolves from the CHILD's cwd, which is the user's
  // workspace, so every launch would fail with ERR_MODULE_NOT_FOUND.
  for (const argument of entry.runner) {
    assert.ok(!/^[a-z@][\w@/.-]*$/i.test(argument) || argument.startsWith("--"),
      `runner argument ${argument} is a bare specifier and would resolve from the payload's directory`)
  }
})

void test("a gate spawned into a directory that knows nothing still reports", async () => {
  const cwd = await elsewhere()
  const handle = spawnLaunchGate({ cwd, env: process.env, activationDeadlineMs: 2_000 })

  const reported = await handle.reported
  assert.equal(reported.identity.processGroupId, reported.identity.pid)

  const exit = await handle.exit
  assert.equal(exit.code, GATE_EXIT.activationDeadline)
})

void test("a launch into a directory that knows nothing runs its payload", async () => {
  const cwd = await elsewhere()
  const ownership = volatileLaunchOwnership()
  const owned = await launchOwnedProcess({
    ownership,
    role: "harness",
    scope: { workspaceId: "ws", directory: cwd },
    payload: { command: "/bin/sh", args: ["-c", "sleep 30"] },
    cwd,
    env: process.env,
  })
  try {
    assert.equal(typeof owned.payloadPid, "number")
    assert.ok(owned.payloadPid! > 0)
  } finally {
    await owned.retire({ termGraceMs: 1_000, killVerifyMs: 1_000 })
  }
})

void test("a gate that cannot start refuses with what the child actually said", async () => {
  const cwd = await elsewhere()
  const previous = process.env.CLAXEDO_LAUNCH_GATE_CHILD
  // A real file this host cannot execute as a gate: it exits non-zero and says
  // why on stderr, which is exactly what a caller must be told.
  const broken = path.join(cwd, "broken-gate.mjs")
  await (await import("node:fs/promises")).writeFile(broken, 'process.stderr.write("gate refused to start: no channel\\n"); process.exit(3)\n')
  process.env.CLAXEDO_LAUNCH_GATE_CHILD = broken
  try {
    const failure = await launchOwnedProcess({
      ownership: volatileLaunchOwnership(),
      role: "harness",
      scope: { workspaceId: "ws", directory: cwd },
      payload: { command: "/bin/sh", args: ["-c", "sleep 30"] },
      cwd,
      env: process.env,
    }).catch((error: unknown) => error)

    assert.ok(failure instanceof LaunchRefusedError, `expected a typed refusal, got ${String(failure)}`)
    assert.match((failure as Error).message, /gate refused to start: no channel/)
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_LAUNCH_GATE_CHILD
    else process.env.CLAXEDO_LAUNCH_GATE_CHILD = previous
  }
})
