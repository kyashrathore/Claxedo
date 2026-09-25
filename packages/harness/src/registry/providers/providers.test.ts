import { expect, test } from "bun:test"
import { createAcpProvider } from "./acp"
import { createPiRpcProvider } from "./pi-rpc"
import { HarnessProviderError } from "./types"
import * as providers from "./index"
import { createTestServices } from "../../conformance/test-support/services"

const acp = () => createAcpProvider(() => ({ kind: "acp" } as never))
const pi = () => createPiRpcProvider(() => ({ kind: "pi-rpc" } as never))

test("provider registry omits the OpenCode server until its adapter moves", () => {
  expect("createOpenCodeServerProvider" in providers).toBe(false)
})

test("ACP validates transport fields and refuses environment bindings for remote agents", () => {
  const provider = acp()
  const local = provider.validateConfig({ label: "Local", connection: { kind: "process", command: "agent" }, secretBindings: { env: { KEY: "key" } } })
  expect(local.connection.kind).toBe("process")
  expect(provider.resolve({ descriptor: { connectionId: "local", providerKey: "acp", configRevision: 1, enabled: true, config: local }, directory: "/work", secrets: { key: "value" } }).config.connection).toEqual({ kind: "process", command: "agent", env: { KEY: "value" } })
  expect(() => provider.validateConfig({ label: "Remote", connection: { kind: "websocket", url: "wss://agent.example" }, secretBindings: { env: { KEY: "key" } } })).toThrow("remote connections cannot bind env secrets")
  expect(() => provider.validateConfig({ label: "Local", connection: { kind: "process", command: "agent", env: { KEY: "literal" } }, secretBindings: { env: { KEY: "key" } } })).toThrow("overwrite")
  expect(() => provider.resolve({ descriptor: { connectionId: "local", providerKey: "acp", configRevision: 1, enabled: true, config: local }, directory: "/work", secrets: {} })).toThrow("lease")
})

test("ACP remote headers resolve only named secrets", () => {
  const provider = acp()
  const config = provider.validateConfig({ label: "Remote", connection: { kind: "streamable-http", url: "https://agent.example" }, secretBindings: { headers: { Authorization: "token" } } })
  expect(provider.resolve({ descriptor: { connectionId: "remote", providerKey: "acp", configRevision: 1, enabled: true, config }, directory: "/work", secrets: { token: "Bearer abc" } }).config.connection).toEqual({ kind: "streamable-http", url: "https://agent.example", headers: { Authorization: "Bearer abc" } })
  expect(() => provider.validateConfig({ label: "Remote", connection: { kind: "websocket", url: "https://agent.example" } })).toThrow("protocol")
  expect(provider.immutableIdentity(config)).toBe(provider.immutableIdentity({ ...config, label: "Renamed" }))
  const descriptor = { connectionId: "remote", providerKey: "acp", configRevision: 1, enabled: true, config }
  const resolved = provider.resolve({ descriptor, directory: "/work", secrets: { token: "Bearer abc" } })
  const transport = provider.createTransport({ descriptor, expectedRevision: 1, resolved, services: createTestServices() })
  expect(transport.kind).toBe("acp")
  expect(() => provider.createTransport({ descriptor: { ...descriptor, enabled: false }, expectedRevision: 1, resolved,
    services: createTestServices() })).toThrow(HarnessProviderError)
  expect(() => provider.createTransport({ descriptor, expectedRevision: 2, resolved,
    services: createTestServices() })).toThrow(HarnessProviderError)
  expect(() => provider.resolve({ descriptor, directory: "/work", secrets: {} })).toThrow("lease")
})

test("Pi defaults its command and keeps environment secret bindings local", () => {
  const provider = pi()
  const config = provider.validateConfig({ label: "Pi", args: ["--mode", "rpc"], secretBindings: { env: { API_KEY: "key" } } })
  expect(config.command).toBe("pi")
  expect(provider.resolve({ descriptor: { connectionId: "pi", providerKey: "pi-rpc", configRevision: 1, enabled: true, config }, directory: "/work", secrets: { key: "secret" } }).config.env).toEqual({ API_KEY: "secret" })
  expect(() => provider.validateConfig({ label: "Pi", secretBindings: { headers: { Authorization: "key" } } })).toThrow("header")
  expect(() => provider.validateConfig({ label: "Pi", env: { API_KEY: "literal" }, secretBindings: { env: { API_KEY: "key" } } })).toThrow("overwrite")
  const descriptor = { connectionId: "pi", providerKey: "pi-rpc", configRevision: 1, enabled: true, config }
  const resolved = provider.resolve({ descriptor, directory: "/work", secrets: { key: "secret" } })
  expect(provider.createTransport({ descriptor, expectedRevision: 1, resolved,
    services: createTestServices() }).kind).toBe("pi-rpc")
  expect(() => provider.createTransport({ descriptor: { ...descriptor, enabled: false }, expectedRevision: 1, resolved,
    services: createTestServices() })).toThrow(HarnessProviderError)
  expect(() => provider.createTransport({ descriptor, expectedRevision: 2, resolved,
    services: createTestServices() })).toThrow(HarnessProviderError)
  expect(() => provider.resolve({ descriptor, directory: "/work", secrets: {} })).toThrow("lease")
})

test("a Pi connection never claims permission requests: its extension UI asks questions", () => {
  const provider = pi()
  const projected = provider.project(provider.validateConfig({ label: "Pi" }))
  expect(projected.capabilities).toMatchObject({ permissions: false, questions: true })
})
