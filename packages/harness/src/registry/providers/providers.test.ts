import { expect, test } from "bun:test"
import { createAcpProvider } from "./acp"
import { TransportError } from "../../contract/errors"
import * as providers from "./index"
import { createTestServices } from "../../conformance/test-support/services"

const acp = () => createAcpProvider(() => ({ kind: "acp" } as never))

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
    services: createTestServices() })).toThrow(TransportError)
  expect(() => provider.createTransport({ descriptor, expectedRevision: 2, resolved,
    services: createTestServices() })).toThrow(TransportError)
  expect(() => provider.resolve({ descriptor, directory: "/work", secrets: {} })).toThrow("lease")
})
