/// <reference types="bun" />
import { afterEach, expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError, type MintedPairing } from "@/server"
import { checkFrom, outcomeFrom, readSshBridge, stepFrom, type SshBridge, type SshCheck, type SshInstallOutcome, type SshInstallStep } from "./ssh-bridge"
import { createSshConnect, sshConnectTransition, sshFailureKey, type SshConnect, type SshConnectEvent } from "./ssh-connect"

const target = { destination: "ubuntu@build-box", port: 2222, folder: "~/code/app" }
const minted: MintedPairing = { id: "pairing_1", code: "K7QM4PXD9R2TWB6HJ3NF", expiresAt: 900_000, commands: { posix: "curl … | sh -s -- K7QM4PXD9R2TWB6HJ3NF", windows: "irm …" } }
const step = (index: number, title: string, runId = "run-1"): SshInstallStep => ({ runId, index, total: 4, title })
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function run(events: readonly SshConnectEvent[], from: SshConnect = { kind: "editing", attempt: 0 }): SshConnect {
  return events.reduce(sshConnectTransition, from)
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "api")
})

test("a reachable machine is minted a code, installed over SSH step by step, and ends installed", () => {
  const installing = run([
    { type: "submitted", target },
    { type: "checked", attempt: 1, check: { kind: "reachable", os: "Linux", arch: "x86_64" } },
    { type: "minted", attempt: 1, minted, runId: "run-1" },
    { type: "stepped", runId: "run-1", step: step(1, "Checking the code with Claxedo") },
    { type: "stepped", runId: "run-0", step: step(1, "a cancelled run's step", "run-0") },
    { type: "stepped", runId: "run-1", step: step(2, "Node 24") },
  ])
  expect(installing).toEqual({ kind: "installing", attempt: 1, target, minted, runId: "run-1", steps: [step(1, "Checking the code with Claxedo"), step(2, "Node 24")] })
  expect(run([{ type: "installEnded", attempt: 1, outcome: { kind: "finished" } }], installing)).toEqual({ kind: "installed", attempt: 1, target, minted, steps: installing.kind === "installing" ? installing.steps : [] })
  expect(run([{ type: "installEnded", attempt: 1, outcome: { kind: "failed", failure: { reason: "remote", line: "This code expired" } } }], installing)).toEqual({
    kind: "failed",
    attempt: 1,
    target,
    failure: { kind: "ssh", failure: { reason: "remote", line: "This code expired" } },
  })
  expect(run([{ type: "installEnded", attempt: 1, outcome: { kind: "cancelled" } }], installing)).toEqual({ kind: "editing", attempt: 1 })
})

test("an unknown host waits for the person to trust its key, and a host that still is not known after trusting fails", () => {
  const unknown: SshCheck = { kind: "unknownHost", scanId: "scan-1", keys: [{ type: "ED25519", fingerprint: "SHA256:abc" }] }
  const confirming = run([{ type: "submitted", target }, { type: "checked", attempt: 1, check: unknown }])
  expect(confirming).toEqual({ kind: "confirmingHost", attempt: 1, target, scanId: "scan-1", keys: unknown.keys })
  const trusting = run([{ type: "trusted" }], confirming)
  expect(run([{ type: "checked", attempt: 1, check: { kind: "reachable", os: "Darwin", arch: "arm64" } }], trusting)).toEqual({ kind: "minting", attempt: 1, target })
  expect(run([{ type: "checked", attempt: 1, check: unknown }], trusting)).toEqual({ kind: "failed", attempt: 1, target, failure: { kind: "ssh", failure: { reason: "hostKeyNotRecorded" } } })
  expect(run([{ type: "edited" }], confirming)).toEqual({ kind: "editing", attempt: 2 })
})

test("an answer from an earlier attempt changes nothing, and a failure keeps the form open for another try", () => {
  const edited = run([{ type: "submitted", target }, { type: "edited" }])
  expect(run([{ type: "checked", attempt: 1, check: { kind: "reachable", os: "Linux", arch: "x86_64" } }], edited)).toEqual(edited)
  const failed = run([{ type: "submitted", target }, { type: "checked", attempt: 1, check: { kind: "failed", failure: { reason: "authRefused" } } }])
  expect(failed).toEqual({ kind: "failed", attempt: 1, target, failure: { kind: "ssh", failure: { reason: "authRefused" } } })
  expect(run([{ type: "submitted", target }], failed)).toEqual({ kind: "checking", attempt: 2, target })
  const minting = run([{ type: "submitted", target }, { type: "checked", attempt: 1, check: { kind: "reachable", os: "Linux", arch: "x86_64" } }])
  const error = new ServerError({ class: "auth", message: "signed out" })
  expect(run([{ type: "mintFailed", attempt: 1, error }], minting)).toEqual({ kind: "failed", attempt: 1, target, failure: { kind: "mint", error } })
  expect(run([{ type: "minted", attempt: 0, minted, runId: "late" }], minting)).toEqual(minting)
})

function fakeBridge(answers: { check?: SshCheck; trust?: SshCheck; install?: Promise<SshInstallOutcome> } = {}) {
  const calls: Array<{ method: string; input: unknown }> = []
  let listener: ((step: SshInstallStep) => void) | undefined
  const bridge: SshBridge = {
    check: async (input) => (calls.push({ method: "check", input }), answers.check ?? { kind: "reachable", os: "Linux", arch: "x86_64" }),
    trust: async (scanId) => (calls.push({ method: "trust", input: scanId }), answers.trust ?? { kind: "reachable", os: "Linux", arch: "x86_64" }),
    install: async (input) => (calls.push({ method: "install", input }), await (answers.install ?? Promise.resolve({ kind: "finished" }))),
    cancel: async (runId) => void calls.push({ method: "cancel", input: runId }),
    onStep: (next) => {
      listener = next
      return () => (listener = undefined)
    },
  }
  return { bridge, calls, step: (value: SshInstallStep) => listener?.(value), listening: () => listener !== undefined }
}

test("connecting checks, mints, installs with the minted code, follows its steps and stops the run when its owner goes", async () => {
  let finish: (outcome: SshInstallOutcome) => void = () => undefined
  const fake = fakeBridge({ install: new Promise((resolve) => (finish = resolve)) })
  const pair = async () => minted
  await createRoot(async (dispose) => {
    const flow = createSshConnect(fake.bridge, { pair })
    await flow.connect(target)
    await settled()
    const state = flow.state()
    expect(state.kind).toBe("installing")
    const runId = state.kind === "installing" ? state.runId : ""
    expect(fake.calls).toEqual([{ method: "check", input: target }, { method: "install", input: { runId, target, code: minted.code } }])
    fake.step(step(1, "Checking the code with Claxedo", runId))
    expect(flow.state()).toMatchObject({ kind: "installing", steps: [{ index: 1, title: "Checking the code with Claxedo" }] })
    flow.dispose()
    expect(fake.calls.at(-1)).toEqual({ method: "cancel", input: runId })
    expect(fake.listening()).toBe(false)
    finish({ kind: "cancelled" })
    dispose()
  })
})

test("trusting a host re-checks through its scan, and a bridge that throws becomes a failure that is shown and logged", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const fake = fakeBridge({ check: { kind: "unknownHost", scanId: "scan-9", keys: [{ type: "ED25519", fingerprint: "SHA256:abc" }] } })
  await createRoot(async (dispose) => {
    const flow = createSshConnect(fake.bridge, { pair: async () => minted })
    await flow.connect(target)
    expect(flow.state().kind).toBe("confirmingHost")
    await flow.trust()
    await settled()
    expect(fake.calls.slice(0, 2)).toEqual([{ method: "check", input: target }, { method: "trust", input: "scan-9" }])
    expect(flow.state().kind).toBe("installed")
    const broken = createSshConnect({ ...fake.bridge, check: async () => Promise.reject(new Error("ipc rejected")) }, { pair: async () => minted })
    await broken.connect(target)
    expect(broken.state()).toEqual({ kind: "failed", attempt: 1, target, failure: { kind: "ssh", failure: { reason: "unavailable" } } })
    expect(errors).toHaveBeenCalled()
    dispose()
  })
  errors.mockRestore()
})

test("the desktop's answers are read into typed values, and anything else is a failure", () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  expect(checkFrom({ kind: "reachable", os: "Linux", arch: "x86_64" })).toEqual({ kind: "reachable", os: "Linux", arch: "x86_64" })
  expect(checkFrom({ kind: "unknownHost", scanId: "s", keys: [{ type: "ED25519", fingerprint: "SHA256:x" }, { type: 1 }] })).toEqual({ kind: "unknownHost", scanId: "s", keys: [{ type: "ED25519", fingerprint: "SHA256:x" }] })
  expect(checkFrom({ kind: "failed", failure: { reason: "unsupportedOs", os: "FreeBSD" } })).toEqual({ kind: "failed", failure: { reason: "unsupportedOs", os: "FreeBSD" } })
  expect(checkFrom({ kind: "failed", failure: { reason: "rm -rf" } })).toEqual({ kind: "failed", failure: { reason: "unavailable" } })
  expect(outcomeFrom({ kind: "failed", failure: { reason: "remote", line: "This code expired" } })).toEqual({ kind: "failed", failure: { reason: "remote", line: "This code expired" } })
  expect(outcomeFrom(undefined)).toEqual({ kind: "failed", failure: { reason: "unavailable" } })
  expect(stepFrom({ runId: "r", index: 2, total: 4, title: "Node 24" })).toEqual({ runId: "r", index: 2, total: 4, title: "Node 24" })
  expect(stepFrom({ runId: "r", index: "2" })).toBeUndefined()
  expect(errors).toHaveBeenCalledTimes(2)
  errors.mockRestore()
})

test("the bridge exists only where the desktop offers it, and names a scan rather than a key", async () => {
  expect(readSshBridge()).toBeUndefined()
  const sent: unknown[] = []
  Reflect.set(globalThis, "api", {
    sshConnect: {
      check: async (input: unknown) => (sent.push(input), { kind: "reachable", os: "Linux", arch: "x86_64" }),
      trust: async (input: unknown) => (sent.push(input), { kind: "failed", failure: { reason: "hostKeyNotRecorded" } }),
      install: async () => ({ kind: "finished" }),
      cancel: async () => undefined,
      onStep: () => () => undefined,
    },
  })
  const bridge = readSshBridge()
  expect(await bridge?.trust("scan-1")).toEqual({ kind: "failed", failure: { reason: "hostKeyNotRecorded" } })
  expect(sent).toEqual([{ scanId: "scan-1" }])
})

test("each failure has its line, and an unsupported system is named when the machine said which", () => {
  expect(sshFailureKey({ reason: "unsupportedOs", os: "FreeBSD" })).toBe("settings.machines.ssh.failed.unsupportedNamedOs")
  expect(sshFailureKey({ reason: "unsupportedOs" })).toBe("settings.machines.ssh.failed.unsupportedOs")
  expect(sshFailureKey({ reason: "authRefused" })).toBe("settings.machines.ssh.failed.authRefused")
})
