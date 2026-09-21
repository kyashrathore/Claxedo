import { describe, expect, test } from "bun:test"
import { acpSpawnEnv, validateACPConnection } from "./transport"

describe("ACP transport environment", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(acpSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })
})

describe("ACP connection transport", () => {
  test("validates exact process, streamable HTTP, and WebSocket descriptors", () => {
    expect(validateACPConnection({ kind: "process", command: "openclaw", args: ["acp"] })).toEqual({
      kind: "process",
      command: "openclaw",
      args: ["acp"],
    })
    expect(validateACPConnection({ kind: "streamable-http", url: "https://agent.example.test/acp" })).toEqual({
      kind: "streamable-http",
      url: "https://agent.example.test/acp",
    })
    expect(validateACPConnection({ kind: "websocket", url: "wss://agent.example.test/acp" })).toEqual({
      kind: "websocket",
      url: "wss://agent.example.test/acp",
    })
  })

  test("filesystem reachability is an explicit assertion independent of transport", () => {
    for (const connection of [
      { kind: "process", command: "bridge" },
      { kind: "streamable-http", url: "https://agent.example/acp" },
      { kind: "websocket", url: "wss://agent.example/acp" },
    ]) {
      expect(validateACPConnection(connection).sharedFilesystem).toBeUndefined()
      expect(validateACPConnection({ ...connection, sharedFilesystem: true }).sharedFilesystem).toBe(true)
      expect(validateACPConnection({ ...connection, sharedFilesystem: false }).sharedFilesystem).toBe(false)
      expect(() => validateACPConnection({ ...connection, sharedFilesystem: "yes" })).toThrow("sharedFilesystem must be boolean")
    }
  })

  test("rejects aliases, mixed local/remote fields, and missing authorities", () => {
    expect(() => validateACPConnection({ kind: "process" })).toThrow("process connection requires command")
    expect(() => validateACPConnection({ kind: "process", command: "agent", url: "https://example.test" })).toThrow(
      "process connection cannot include url",
    )
    expect(() => validateACPConnection({ kind: "streamable-http" })).toThrow("streamable-http connection requires url")
    expect(() => validateACPConnection({ kind: "websocket", url: "wss://example.test", command: "agent" })).toThrow(
      "websocket connection cannot include command",
    )
    expect(() => validateACPConnection({ kind: "streamable-http", url: "wss://example.test" })).toThrow(
      "streamable-http connection URL uses an unsupported protocol",
    )
    expect(() => validateACPConnection({ kind: "websocket", url: "https://example.test" })).toThrow(
      "websocket connection URL uses an unsupported protocol",
    )
    expect(() => validateACPConnection({ kind: "remote", url: "https://example.test" })).toThrow(
      "connection kind must be process, streamable-http, or websocket",
    )
    expect(() => validateACPConnection({ kind: "http", url: "https://example.test" })).toThrow(
      "connection kind must be process, streamable-http, or websocket",
    )
  })
})
