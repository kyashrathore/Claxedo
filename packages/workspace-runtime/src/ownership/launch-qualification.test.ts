// `node:test`'s `describe`/`it` return a promise the runner already owns, so
// every registration below is deliberately `void`ed.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { sleep } from "@claxedo/helpers"
import {
  GATE_EXIT,
  LaunchOwnershipStore,
  drainOwnedGroup,
  readCreationIdentity,
  reconcileLaunch,
  signalOwnedGroup,
  spawnLaunchGate,
  verifyCreationIdentity,
  type CreationIdentity,
  type GatePayload,
  type LaunchRecord,
} from "./launch-gate"

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL("../..", import.meta.url))
const launchGateModule = fileURLToPath(new URL("./launch-gate.ts", import.meta.url))

let root = ""
const strays: ChildProcess[] = []
const strayPids: number[] = []

const uniqueDir = async () => {
  const dir = path.join(root, `case-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const until = async <T>(read: () => Promise<T | undefined>, timeoutMs: number, what: string) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(20)
  }
}

const exists = (file: string) => fs.access(file).then(() => true, () => false)

const markerPayload = (marker: string): GatePayload => ({
  command: process.execPath,
  args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
})

/**
 * A payload that stays inside its owned group while its own child leaves it
 * through `detached`, which is the `setsid` escape the process-group scope
 * cannot follow.
 */
const escapingPayload = (marker: string, escapeePidFile: string): GatePayload => ({
  command: process.execPath,
  args: ["-e", [
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    `const escapee = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(escapeePidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}], { detached: true, stdio: "ignore" })`,
    `escapee.unref()`,
    `setInterval(() => {}, 1000)`,
  ].join(";")],
})

const inGroupPayload = (childPidFile: string): GatePayload => ({
  command: process.execPath,
  args: ["-e", [
    `const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`require("fs").writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}], { stdio: "ignore" })`,
    `setInterval(() => {}, 1000)`,
  ].join(";")],
})

/**
 * A separate owning process, so "the parent died" is a real process death and
 * not this test closing a channel it still holds open.
 */
const spawnParentProxy = async (input: { dir: string; mode: "hold" | "activate"; payload: GatePayload; activationDeadlineMs: number }) => {
  const proxy = path.join(input.dir, "parent-proxy.mjs")
  const storeFile = path.join(input.dir, "ownership.json")
  await fs.writeFile(proxy, [
    `import { LaunchOwnershipStore, spawnLaunchGate } from ${JSON.stringify(launchGateModule)}`,
    `const store = new LaunchOwnershipStore(${JSON.stringify(storeFile)})`,
    `const prepared = await store.prepare("harness")`,
    `const handle = spawnLaunchGate({ payload: ${JSON.stringify(input.payload)}, activationDeadlineMs: ${input.activationDeadlineMs} })`,
    `const reported = await handle.reported`,
    `await store.recordIdentity(prepared.launchId, reported.identity, reported.gateNonce)`,
    input.mode === "activate"
      ? [
        `await store.recordActivationAuthorized(prepared.launchId)`,
        `handle.child.send({ type: "activate", gateNonce: reported.gateNonce }, () => process.kill(process.pid, "SIGKILL"))`,
      ].join("\n")
      : "",
    `await new Promise(() => {})`,
  ].join("\n"), "utf8")
  const runner = process.versions.bun ? [proxy] : ["--import", "tsx", proxy]
  const child = spawn(process.execPath, runner, { cwd: packageDir, stdio: ["ignore", "ignore", "pipe"] })
  strays.push(child)
  let stderr = ""
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const store = new LaunchOwnershipStore(storeFile)
  const record = await until(async () => {
    if (child.exitCode !== null) throw new Error(`Parent proxy exited with ${child.exitCode}: ${stderr}`)
    const records = Object.values(await store.readAll())
    return records.find((entry) => entry.identity)
  }, 20_000, "the gate to report its creation identity to the parent proxy").catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\nproxy stderr: ${stderr}` : ""}`)
  })
  const identity = record.identity
  assert.ok(identity, "the proxy stored a creation identity")
  strayPids.push(identity.pid)
  return { proxy: child, store, record, identity }
}

const trackGate = (identity: CreationIdentity) => { strayPids.push(identity.pid) }

void describe("launch gate qualification", { concurrency: false }, () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "launch-gate-qualification-"))
  })

  after(async () => {
    for (const child of strays) {
      try { child.kill("SIGKILL") } catch { /* already exited */ }
    }
    for (const pid of strayPids) {
      try { process.kill(-pid, "SIGKILL") } catch { /* group already gone */ }
      try { process.kill(pid, "SIGKILL") } catch { /* already exited */ }
    }
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  void describe("platform measurements", () => {
    void it("gives a spawn with detached:true its own process group", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
      strays.push(child)
      assert.ok(child.pid)
      const detached = await until(() => readCreationIdentity(child.pid!).then((value) => value ?? undefined), 5_000, "the detached child to appear in ps")
      const self = await readCreationIdentity(process.pid)
      assert.equal(detached.processGroupId, child.pid, "a detached child leads its own process group")
      assert.notEqual(detached.processGroupId, self?.processGroupId, "the detached child left the launcher's group")
      child.kill("SIGKILL")
    })

    void it("reaches every member of an owned group through kill(-pgid)", async () => {
      const dir = await uniqueDir()
      const childPidFile = path.join(dir, "in-group.pid")
      const handle = spawnLaunchGate({ payload: inGroupPayload(childPidFile), activationDeadlineMs: 10_000 })
      strays.push(handle.child)
      const reported = await handle.reported
      trackGate(reported.identity)
      handle.activate(reported.gateNonce)
      const memberPid = Number(await until(async () => (await exists(childPidFile)) ? fs.readFile(childPidFile, "utf8") : undefined, 20_000, "the in-group grandchild"))
      assert.ok(alive(memberPid))
      const outcome = await signalOwnedGroup(reported.identity, "SIGKILL")
      assert.deepEqual(outcome, { signalled: true, processGroupId: reported.identity.pid })
      await until(async () => (!alive(memberPid) && !alive(reported.identity.pid)) || undefined, 5_000, "every group member to exit")
    })

    void it("reads creation time at one-second resolution, leaving a same-second reuse window", async () => {
      const self = await readCreationIdentity(process.pid)
      assert.ok(self)
      assert.equal(self.startedAtSource, "ps-lstart")
      assert.match(self.startedAt, /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/, "ps lstart carries no sub-second field")
      await assert.rejects(execFileAsync("sysctl", ["-n", `kern.proc.pid.${process.pid}`]), "macOS does not expose kern.proc.pid through the sysctl CLI")
    })

    void it("gives bun's child_process.spawn the same detached process group", async (context) => {
      const bun = await execFileAsync("bun", ["--version"]).then((value) => value.stdout.trim(), () => "")
      if (!bun) return context.skip("bun is not on PATH")
      const { stdout } = await execFileAsync("bun", ["-e", [
        `const { spawn, execFileSync } = require("child_process")`,
        `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { detached: true, stdio: "ignore" })`,
        `setTimeout(() => { const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)]).toString().trim(); console.log(JSON.stringify({ pid: child.pid, pgid: Number(pgid) })); child.kill("SIGKILL"); process.exit(0) }, 250)`,
      ].join(";")])
      const observed = JSON.parse(stdout.trim()) as { pid: number; pgid: number }
      assert.equal(observed.pgid, observed.pid, `bun ${bun} detaches into a new process group like node`)
    })
  })

  void describe("the protocol's execution facts", () => {
    void it("reconciles a prepared launch that was never spawned as no execution", async () => {
      const dir = await uniqueDir()
      const store = new LaunchOwnershipStore(path.join(dir, "ownership.json"))
      const prepared = await store.prepare("turn")
      const record = await store.read(prepared.launchId)
      assert.equal(record.identity, undefined)
      assert.deepEqual(reconcileLaunch(record), { execution: "none", because: "no creation identity was ever received over the gate channel" })
    })

    void it("exits without running the payload when the private channel closes before activation", async () => {
      const dir = await uniqueDir()
      const marker = path.join(dir, "payload.marker")
      const handle = spawnLaunchGate({ payload: markerPayload(marker), activationDeadlineMs: 30_000 })
      strays.push(handle.child)
      const reported = await handle.reported
      trackGate(reported.identity)
      handle.child.disconnect()
      const exit = await handle.exit
      assert.equal(exit.code, GATE_EXIT.channelLostBeforeActivation)
      assert.equal(await exists(marker), false, "the payload never ran")
    })

    void it("exits without running the payload when the owning parent process dies before identity is used", async () => {
      const dir = await uniqueDir()
      const marker = path.join(dir, "payload.marker")
      const { proxy, store, identity } = await spawnParentProxy({ dir, mode: "hold", payload: markerPayload(marker), activationDeadlineMs: 30_000 })
      const killed = Date.now()
      proxy.kill("SIGKILL")
      await until(async () => alive(identity.pid) ? undefined : true, 10_000, "the gate to exit after its parent died")
      assert.ok(Date.now() - killed < 5_000, "the gate exited on channel loss, not at its 30s activation deadline")
      assert.equal(await exists(marker), false, "the payload never ran")
      const record = Object.values(await store.readAll())[0] as LaunchRecord
      assert.deepEqual(reconcileLaunch(record), { execution: "none", because: "identity was received and activation was never authorized" })
    })

    void it("exits at the activation deadline when activation never arrives", async () => {
      const dir = await uniqueDir()
      const marker = path.join(dir, "payload.marker")
      const handle = spawnLaunchGate({ payload: markerPayload(marker), activationDeadlineMs: 2_000 })
      strays.push(handle.child)
      const reported = await handle.reported
      trackGate(reported.identity)
      const exit = await handle.exit
      assert.equal(exit.code, GATE_EXIT.activationDeadline)
      assert.equal(await exists(marker), false, "the payload never ran")
    })

    void it("refuses activation that does not carry the nonce the gate minted", async () => {
      const dir = await uniqueDir()
      const marker = path.join(dir, "payload.marker")
      const handle = spawnLaunchGate({ payload: markerPayload(marker), activationDeadlineMs: 30_000 })
      strays.push(handle.child)
      const reported = await handle.reported
      trackGate(reported.identity)
      handle.activate("00000000-0000-4000-8000-000000000000")
      const exit = await handle.exit
      assert.equal(exit.code, GATE_EXIT.nonceMismatch)
      assert.equal(await exists(marker), false, "an argv or environment token never authorizes the payload")
    })

    void it("runs the payload and stays reacquirable when the parent dies before acknowledgement", async () => {
      const dir = await uniqueDir()
      const childPidFile = path.join(dir, "in-group.pid")
      const { proxy, store, identity } = await spawnParentProxy({ dir, mode: "activate", payload: inGroupPayload(childPidFile), activationDeadlineMs: 30_000 })
      await until(async () => proxy.exitCode !== null || proxy.signalCode !== null ? true : undefined, 10_000, "the owning parent to die")
      const memberPid = Number(await until(async () => (await exists(childPidFile)) ? fs.readFile(childPidFile, "utf8") : undefined, 20_000, "the payload to run after the parent died"))
      assert.ok(alive(memberPid), "the payload kept running with no parent")

      const record = Object.values(await store.readAll())[0] as LaunchRecord
      assert.deepEqual(reconcileLaunch(record), { execution: "unknown", because: "activation was authorized and its delivery is unwitnessed" })

      const verdict = await verifyCreationIdentity(identity)
      assert.equal(verdict.state, "live", "a fresh owner reacquires the launch by (pid, start time)")
      const outcome = await signalOwnedGroup(identity, "SIGKILL")
      assert.deepEqual(outcome, { signalled: true, processGroupId: identity.pid })
      await until(async () => (!alive(memberPid) && !alive(identity.pid)) || undefined, 5_000, "the reacquired group to exit")
    })
  })

  void describe("identity reacquisition", () => {
    void it("reports an exited launch instead of signalling its pid", async () => {
      const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" })
      strays.push(child)
      assert.ok(child.pid)
      const identity = await until(() => readCreationIdentity(child.pid!).then((value) => value ?? undefined), 5_000, "the short-lived child in ps")
      await new Promise((resolve) => child.on("exit", resolve))
      await until(async () => (await readCreationIdentity(identity.pid)) === null || undefined, 5_000, "the child to leave the process table")
      assert.deepEqual(await verifyCreationIdentity(identity), { state: "exited" })
      assert.deepEqual(await signalOwnedGroup(identity, "SIGTERM"), { signalled: false, reason: "exited" })
    })

    void it("refuses to signal a live pid whose recorded creation time does not match", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
      strays.push(child)
      assert.ok(child.pid)
      const observed = await until(() => readCreationIdentity(child.pid!).then((value) => value ?? undefined), 5_000, "the child in ps")
      const stale: CreationIdentity = { ...observed, startedAt: "Mon Jan  1 00:00:00 2001" }
      const verdict = await verifyCreationIdentity(stale)
      assert.equal(verdict.state, "identity-mismatch")
      assert.deepEqual(await signalOwnedGroup(stale, "SIGKILL"), { signalled: false, reason: "identity-mismatch" })
      assert.ok(alive(child.pid), "the reused-pid candidate was left running")
      child.kill("SIGKILL")
    })

    void it("refuses to signal a recorded process that does not lead its own group", async () => {
      const identity = await readCreationIdentity(process.pid)
      assert.ok(identity)
      assert.notEqual(identity.processGroupId, identity.pid, "this test runner is not its own group leader")
      assert.deepEqual(await signalOwnedGroup(identity, "SIGTERM"), { signalled: false, reason: "not-group-leader" })
    })
  })

  void describe("descendant containment", () => {
    void it("reports cleanup as unknown when a descendant leaves the owned group", async () => {
      const dir = await uniqueDir()
      const marker = path.join(dir, "payload.marker")
      const escapeePidFile = path.join(dir, "escapee.pid")
      const handle = spawnLaunchGate({ payload: escapingPayload(marker, escapeePidFile), activationDeadlineMs: 30_000 })
      strays.push(handle.child)
      const reported = await handle.reported
      trackGate(reported.identity)
      handle.activate(reported.gateNonce)
      const escapeePid = Number(await until(async () => (await exists(escapeePidFile)) ? fs.readFile(escapeePidFile, "utf8") : undefined, 20_000, "the escaping descendant"))
      strayPids.push(escapeePid)
      const escapee = await readCreationIdentity(escapeePid)
      assert.ok(escapee)
      assert.notEqual(escapee.processGroupId, reported.identity.processGroupId, "the descendant left the owned group")

      const outcome = await drainOwnedGroup(reported.identity, 5_000)
      assert.equal(outcome.group, "exited")
      assert.equal(outcome.cleanup, "unknown", "an empty owned group is not proof the launch's tree is gone")
      assert.ok(alive(escapeePid), "the escaped descendant survived the group kill, which is why cleanup stays unknown")
      process.kill(escapeePid, "SIGKILL")
    })
  })
})
