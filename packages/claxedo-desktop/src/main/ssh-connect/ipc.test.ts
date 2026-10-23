import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter, once } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { spawn } from "node:child_process"
import { registerSshConnectIpc, SSH_CONNECT_OPERATIONS, SSH_CONNECT_STEP_CHANNEL, sshConnectChannel, type SshConnectIpcListener } from "./ipc"
import { CONNECT_SCRIPT_SHA256_HEADER } from "@claxedo/account-contract/machine"

const CODE = "K7QM4PXD9R2TWB6HJ3NF"
const HOST_LINE = "[box.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICX079r531CBZjYiArZzwS//NCMiAyVxkuBy42D26aT1"
const SCRIPT = '#!/bin/sh\nCLAXEDO_CONTROL_PLANE_URL=\'https://plane.test\'\necho "1/4 Checking the code with Claxedo"\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Call = { program: string; args: string[]; stdin: string }
type Reply = { stdout?: string; stderr?: string; code?: number | null; hang?: boolean } | "missing"

function scriptedSpawn(reply: (call: Call) => Reply) {
  const calls: Call[] = []
  const spawnFake = (program: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true })
    const input: Buffer[] = []
    child.stdin.on("data", (chunk: Buffer) => input.push(chunk))
    const close = async (code: number | null) => {
      child.stdout.end()
      child.stderr.end()
      await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")])
      child.emit("close", code)
    }
    child.kill = () => {
      void close(null)
      return true
    }
    child.stdin.on("finish", () => {
      const call = { program, args, stdin: Buffer.concat(input).toString("utf8") }
      calls.push(call)
      const answer = reply(call)
      if (answer === "missing") return child.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }))
      if (answer.stdout) child.stdout.write(answer.stdout)
      if (answer.stderr) child.stderr.write(answer.stderr)
      if (!answer.hang) void close(answer.code ?? 0)
    })
    return child
  }
  return { spawn: spawnFake as unknown as typeof spawn, calls }
}

function machine(input: { os?: string; probeCode?: number; installReply?: Reply } = {}) {
  const home = mkdtempSync(join(tmpdir(), "claxedo-ssh-ipc-"))
  roots.push(home)
  const knownHosts = join(home, ".ssh", "known_hosts")
  const known = () => {
    try {
      return readFileSync(knownHosts, "utf8").includes(HOST_LINE)
    } catch {
      return false
    }
  }
  const scripted = scriptedSpawn((call) => {
    if (call.program === "ssh-keygen") return { stdout: "256 SHA256:MgN6WKsX+JtA/y8FGacq/e17lqSAVKuiJksWA9RVdRQ [box.test]:2222 (ED25519)\n" }
    if (call.args[0] === "-G") return { stdout: `user ubuntu\nuserknownhostsfile ${knownHosts} ${knownHosts}2\n` }
    const scan = call.args.find((arg) => arg.startsWith("UserKnownHostsFile="))
    if (scan) {
      writeFileSync(scan.slice("UserKnownHostsFile=".length), `${HOST_LINE}\n`)
      return { stderr: "Warning: Permanently added '[box.test]:2222' (ED25519) to the list of known hosts.\nubuntu@box.test: Permission denied (publickey).\n", code: 255 }
    }
    if (!known()) return { stderr: "No ED25519 host key is known for [box.test]:2222 and you have requested strict checking.\nHost key verification failed.\n", code: 255 }
    if (call.args.at(-1) === "uname -sm") return { stdout: `${input.os ?? "Linux x86_64"}\n`, code: input.probeCode ?? 0 }
    return input.installReply ?? { stdout: "1/4 Checking the code with Claxedo\n2/4 Node 24\n    node found\n3/4 claxedo\n4/4 Connecting this machine\nbox is ready in Claxedo.\n" }
  })
  const trust = () => {
    mkdirSync(join(home, ".ssh"), { recursive: true })
    writeFileSync(knownHosts, `${HOST_LINE}\n`, { flag: "a" })
  }
  return { home, knownHosts, ...scripted, trust }
}

function sender(id = 1) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const events = new EventEmitter()
  let destroyed = false
  return {
    sent,
    destroy: () => {
      destroyed = true
      events.emit("destroyed")
    },
    value: {
      id,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      isDestroyed: () => destroyed,
      once: (event: string, listener: () => void) => events.once(event, listener),
      removeListener: (event: string, listener: () => void) => events.removeListener(event, listener),
    },
  }
}

function scriptResponse(body: string, digest = createHash("sha256").update(body).digest("hex"), status = 200) {
  return new Response(body, { status, headers: digest ? { [CONNECT_SCRIPT_SHA256_HEADER]: digest } : {} })
}

function surface(spawned: ReturnType<typeof machine>, options: { controlPlaneUrl?: string; fetch?: (url: URL) => Promise<Response> } = {}) {
  const handlers = new Map<string, SshConnectIpcListener>()
  const fetched: string[] = []
  const registered = registerSshConnectIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    controlPlaneUrl: "controlPlaneUrl" in options ? options.controlPlaneUrl : "https://plane.test",
    tools: { ssh: "ssh", sshKeygen: "ssh-keygen", spawn: spawned.spawn },
    fetch: async (url) => {
      fetched.push(url.toString())
      return await (options.fetch ?? (async () => scriptResponse(SCRIPT)))(url)
    },
  })
  const invoke = async (operation: (typeof SSH_CONNECT_OPERATIONS)[number], payload: unknown, from = sender()) => {
    const handler = handlers.get(sshConnectChannel(operation))
    if (!handler) throw new Error(`no handler for ${operation}`)
    return await handler({ sender: from.value }, payload)
  }
  return { registered, handlers, invoke, fetched }
}

const target = { destination: "ubuntu@box.test", port: 2222, folder: "~/code/app" }

describe("checking a machine", () => {
  test("a known Linux or macOS host is reachable", async () => {
    const box = machine()
    box.trust()
    expect(await surface(box).invoke("check", target)).toEqual({ kind: "reachable", os: "Linux", arch: "x86_64" })
    const darwin = machine({ os: "Welcome to the build Mac\nDarwin arm64" })
    darwin.trust()
    expect(await surface(darwin).invoke("check", target)).toEqual({ kind: "reachable", os: "Darwin", arch: "arm64" })
  })

  test("a host that is not Linux or macOS is refused before anything is minted or installed", async () => {
    const bsd = machine({ os: "FreeBSD amd64" })
    bsd.trust()
    expect(await surface(bsd).invoke("check", target)).toEqual({ kind: "failed", failure: { reason: "unsupportedOs", os: "FreeBSD" } })
    const windows = machine({ os: "'uname' is not recognized as an internal or external command,", probeCode: 1 })
    windows.trust()
    expect(await surface(windows).invoke("check", target)).toEqual({ kind: "failed", failure: { reason: "unsupportedOs" } })
  })

  test("an unknown host shows its fingerprint and is trusted only through main's own scan, into the person's known_hosts", async () => {
    const box = machine()
    const ipc = surface(box)
    const from = sender(7)
    const asked = await ipc.invoke("check", target, from)
    expect(asked).toMatchObject({ kind: "unknownHost", keys: [{ type: "ED25519", fingerprint: "SHA256:MgN6WKsX+JtA/y8FGacq/e17lqSAVKuiJksWA9RVdRQ" }] })
    const scan = box.calls.find((call) => call.args.some((arg) => arg.startsWith("UserKnownHostsFile=")))
    expect(scan?.args).toEqual(expect.arrayContaining(["StrictHostKeyChecking=accept-new", "PreferredAuthentications=none", "IdentityAgent=none"]))
    const scanId = (asked as { scanId: string }).scanId
    expect(await ipc.invoke("trust", { scanId }, sender(8))).toEqual({ kind: "failed", failure: { reason: "invalidTarget" } })
    expect(readdirSync(box.home)).toEqual([])
    expect(await ipc.invoke("trust", { scanId }, from)).toEqual({ kind: "reachable", os: "Linux", arch: "x86_64" })
    expect(readFileSync(box.knownHosts, "utf8")).toBe(`${HOST_LINE}\n`)
    expect(await ipc.invoke("trust", { scanId }, from)).toEqual({ kind: "failed", failure: { reason: "invalidTarget" } })
  })

  test("each ssh failure is one reason", async () => {
    const reply = (stderr: string) => scriptedSpawn(() => ({ stderr, code: 255 }))
    const cases: Array<[Reply | "missing", string]> = [
      [{ stderr: "ubuntu@box.test: Permission denied (publickey).\n", code: 255 }, "authRefused"],
      [{ stderr: "ssh: connect to host box.test port 2222: Connection refused\n", code: 255 }, "unreachable"],
      [{ stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n", code: 255 }, "hostKeyChanged"],
      ["missing", "sshMissing"],
    ]
    for (const [answer, reason] of cases) {
      const box = { ...machine(), ...(typeof answer === "string" ? scriptedSpawn(() => "missing") : reply(answer.stderr ?? "")) }
      expect(await surface(box).invoke("check", target)).toEqual({ kind: "failed", failure: { reason } })
    }
    expect(await surface(machine()).invoke("check", { ...target, identityFile: "/nowhere/id_ed25519" })).toEqual({ kind: "failed", failure: { reason: "keyMissing" } })
    expect(await surface(machine()).invoke("check", { destination: "-oProxyCommand=id" })).toEqual({ kind: "failed", failure: { reason: "invalidTarget" } })
  })
})

describe("installing over ssh", () => {
  test("streams exactly the verified script to sh -s in the chosen folder and pushes the numbered steps", async () => {
    const box = machine()
    box.trust()
    const ipc = surface(box)
    const from = sender()
    expect(await ipc.invoke("install", { runId: "run-1", target, code: CODE.toLowerCase() }, from)).toEqual({ kind: "finished" })
    expect(ipc.fetched).toEqual(["https://plane.test/api/claxedo/connect"])
    const install = box.calls.at(-1)
    expect(install?.stdin).toBe(SCRIPT)
    expect(install?.args.slice(install.args.indexOf("--"))).toEqual([
      "--",
      "ubuntu@box.test",
      `sh -c 'f=$1; shift; case $f in "~") f=$HOME ;; "~/"*) f=$HOME/\${f#"~/"} ;; esac; cd "$f" 2>/dev/null || exit 66; exec sh -s -- "$@"' sh '~/code/app' '${CODE}'`,
    ])
    expect(install?.args).toContain("StrictHostKeyChecking=yes")
    expect(from.sent).toEqual([
      { channel: SSH_CONNECT_STEP_CHANNEL, payload: { runId: "run-1", index: 1, total: 4, title: "Checking the code with Claxedo" } },
      { channel: SSH_CONNECT_STEP_CHANNEL, payload: { runId: "run-1", index: 2, total: 4, title: "Node 24" } },
      { channel: SSH_CONNECT_STEP_CHANNEL, payload: { runId: "run-1", index: 3, total: 4, title: "claxedo" } },
      { channel: SSH_CONNECT_STEP_CHANNEL, payload: { runId: "run-1", index: 4, total: 4, title: "Connecting this machine" } },
    ])
  })

  test("a script that does not match the sha256 the control plane states never reaches the machine", async () => {
    const outcomes = []
    for (const response of [scriptResponse(SCRIPT, "0".repeat(64)), scriptResponse(SCRIPT, ""), scriptResponse(`${SCRIPT}rm -rf ~\n`, createHash("sha256").update(SCRIPT).digest("hex"))]) {
      const box = machine()
      box.trust()
      outcomes.push(await surface(box, { fetch: async () => response }).invoke("install", { runId: "run-1", target, code: CODE }))
      expect(box.calls).toEqual([])
    }
    expect(outcomes).toEqual(Array(3).fill({ kind: "failed", failure: { reason: "scriptUnverified" } }))
    const down = machine()
    expect(await surface(down, { fetch: async () => scriptResponse("oops", undefined, 503) }).invoke("install", { runId: "r", target, code: CODE })).toEqual({ kind: "failed", failure: { reason: "scriptUnavailable" } })
    expect(await surface(down, { fetch: async () => Promise.reject(new Error("ECONNRESET")) }).invoke("install", { runId: "r", target, code: CODE })).toEqual({ kind: "failed", failure: { reason: "scriptUnavailable" } })
    expect(await surface(down, { controlPlaneUrl: undefined }).invoke("install", { runId: "r", target, code: CODE })).toEqual({ kind: "failed", failure: { reason: "unavailable" } })
    expect(down.calls).toEqual([])
  })

  test("the machine's refusal, a missing folder and a dropped connection are each one reason", async () => {
    const outcome = async (installReply: Reply) => {
      const box = machine({ installReply })
      box.trust()
      return await surface(box).invoke("install", { runId: "run-1", target, code: CODE })
    }
    expect(await outcome({ stdout: "1/4 Checking the code with Claxedo\n", stderr: "This code expired; open Connect a machine… in Claxedo for a new one.\n", code: 1 })).toEqual({
      kind: "failed",
      failure: { reason: "remote", line: "This code expired; open Connect a machine… in Claxedo for a new one." },
    })
    expect(await outcome({ stdout: "4/4 Connecting this machine\nThe owner denied this machine in Claxedo.\n", code: 78 })).toEqual({ kind: "failed", failure: { reason: "remote", line: "The owner denied this machine in Claxedo." } })
    expect(await outcome({ code: 66 })).toEqual({ kind: "failed", failure: { reason: "folderMissing" } })
    expect(await outcome({ stdout: "2/4 Node 24\n", stderr: "Connection to box.test closed by remote host.\n", code: 255 })).toEqual({ kind: "failed", failure: { reason: "disconnected" } })
    expect(await outcome({ stderr: "ubuntu@box.test: Permission denied (publickey).\n", code: 255 })).toEqual({ kind: "failed", failure: { reason: "authRefused" } })
  })

  test("cancel and a closed window stop the run; only its own window can cancel it", async () => {
    const box = machine({ installReply: { stdout: "1/4 Checking the code with Claxedo\n", hang: true } })
    box.trust()
    const ipc = surface(box)
    const from = sender(3)
    const running = ipc.invoke("install", { runId: "run-1", target, code: CODE }, from)
    while (!from.sent.length) await new Promise((resolve) => setTimeout(resolve, 5))
    await ipc.invoke("cancel", { runId: "run-1" }, sender(4))
    await ipc.invoke("cancel", { runId: "run-1" }, from)
    expect(await running).toEqual({ kind: "cancelled" })
    const closing = sender(5)
    const second = ipc.invoke("install", { runId: "run-2", target, code: CODE }, closing)
    while (!closing.sent.length) await new Promise((resolve) => setTimeout(resolve, 5))
    closing.destroy()
    expect(await second).toEqual({ kind: "cancelled" })
  })

  test("refuses a malformed code, run id or target before fetching anything", async () => {
    const box = machine()
    const ipc = surface(box)
    for (const payload of [
      { runId: "run-1", target, code: "not-a-code" },
      { runId: "run 1", target, code: CODE },
      { runId: "run-1", target: { destination: "-oProxyCommand=id" }, code: CODE },
      { runId: "run-1", code: CODE },
    ]) {
      expect(await ipc.invoke("install", payload)).toEqual({ kind: "failed", failure: { reason: "invalidTarget" } })
    }
    expect(ipc.fetched).toEqual([])
    expect(box.calls).toEqual([])
  })
})

describe("the surface", () => {
  test("registers exactly the four operations, and the preload bridge names exactly them", () => {
    const ipc = surface(machine())
    expect(ipc.registered.channels).toEqual(SSH_CONNECT_OPERATIONS.map(sshConnectChannel))
    expect([...ipc.handlers.keys()]).toEqual(ipc.registered.channels)
    const preload = readFileSync(join(import.meta.dir, "../../preload/index.ts"), "utf8")
    const bridge = preload.slice(preload.indexOf("sshConnect: {"))
    for (const operation of SSH_CONNECT_OPERATIONS) expect(bridge).toContain(`"claxedo.sshConnect.${operation}"`)
    expect(bridge.match(/\binvoke[(<]/g)?.length).toBe(SSH_CONNECT_OPERATIONS.length)
    expect(bridge).toContain(`"${SSH_CONNECT_STEP_CHANNEL}"`)
  })

  test("is registered after the caller guard is installed", () => {
    const entry = readFileSync(join(import.meta.dir, "../index.ts"), "utf8")
    const installed = entry.indexOf("installIpcCallerGuard({")
    const registered = entry.indexOf("registerSshConnectIpc({")
    expect(installed).toBeGreaterThan(-1)
    expect(registered).toBeGreaterThan(installed)
  })
})
