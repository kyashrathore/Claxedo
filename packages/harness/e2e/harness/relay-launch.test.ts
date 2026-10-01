import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-relay-launch-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))
const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
const childProcess = await import("node:child_process")
const originals = { childProcess: { ...childProcess }, health: { ...await import("./health") } }
afterAll(() => {
  mock.module("node:child_process", () => originals.childProcess)
  mock.module("./health", () => originals.health)
})
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    launches.push({ command, args, env: options.env })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
      kill: () => { queueMicrotask(() => child.emit("exit", 0)); return true },
    })
    queueMicrotask(() => child.stdout.emit("data", Buffer.from("[workspace-relay] listening on test")))
    return child
  },
}))
mock.module("./health", () => ({ waitForHealth: async () => {} }))
const { startHostedRelay } = await import("./hosted-relay")
const { startRelay } = await import("../../../claxedo-app/e2e/harness/relay")
const { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } = await import("./hosted-keys")
beforeEach(() => { launches.length = 0 })

test("hosted relay launches the production Durable Object Worker with the hosted signing keys", async () => {
  const relay = await startHostedRelay({ root, port: 41002, controlPlaneUrl: "https://127.0.0.1:41003", certificate: "/test/cert.pem" })
  expect(launches[0].command).toBe("node")
  expect(launches[0].args.at(-1)).toBe(path.join(import.meta.dirname, "relay-workerd.mjs"))
  const configuration = JSON.parse(launches[0].env.CLAXEDO_E2E_RELAY_WORKER!)
  expect(configuration.bindings.CLAXEDO_RELAY_RESOLVER_URL).toBe("https://127.0.0.1:41003/internal/relay")
  expect(configuration.bindings.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM).toBe(HOSTED_SIGNING_PRIVATE_KEY)
  expect(configuration.bindings.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM).toBe(HOSTED_SIGNING_PUBLIC_KEY)
  expect(launches[0].env.NODE_EXTRA_CA_CERTS).toBe("/test/cert.pem")
  expect(launches[0].env.HOME).toStartWith(root)
  await relay.close()
})

test("app cloud relay uses workerd with an isolated ephemeral relay key and declared origins", async () => {
  const relay = await startRelay({ root, port: 41004, resolverToken: "test-resolver", controlPlaneUrl: "http://127.0.0.1:41005", runtimePublicPem: HOSTED_SIGNING_PUBLIC_KEY, allowedOrigins: ["https://127.0.0.1:41006"] })
  expect(launches[0].command).toBe("node")
  expect(launches[0].args.at(-1)).toBe(path.join(import.meta.dirname, "relay-workerd.mjs"))
  const configuration = JSON.parse(launches[0].env.CLAXEDO_E2E_RELAY_WORKER!)
  expect(configuration.bindings.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM).toContain("BEGIN PRIVATE KEY")
  expect(configuration.bindings.CLAXEDO_RELAY_RESOLVER_TOKEN).toBe("test-resolver")
  expect(configuration.bindings.CLAXEDO_RELAY_ALLOWED_ORIGINS).toBe("https://127.0.0.1:41006")
  expect(relay.resolverToken).toBe("test-resolver")
  await relay.close()
})
