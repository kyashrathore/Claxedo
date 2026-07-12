import { describe, expect, test } from "bun:test"
import {
  createTerminalPtyClient,
  openTerminalWebSocket,
  sigwinchToggleSize,
  WebSocketCloseError,
  socketCloseIsError,
  isRetriableClose,
  reconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
  reconnectingMessage,
  reconnectedMessage,
  reconnectFailedMessage,
  terminalPtyApiPath,
} from "./terminal-connection"

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

class FakeWebSocket {
  static urls: string[] = []
  static connections: Array<{ url: string; protocols?: string | string[] }> = []
  url: string
  binaryType = ""
  readyState = 0

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    FakeWebSocket.urls.push(String(url))
    FakeWebSocket.connections.push({ url: String(url), protocols })
  }

  close() {}
  send() {}
}

describe("sigwinchToggleSize", () => {
  test("returns cols-1 then cols to force SIGWINCH", () => {
    const [first, second] = sigwinchToggleSize(80, 24)
    expect(first).toEqual({ cols: 79, rows: 24 })
    expect(second).toEqual({ cols: 80, rows: 24 })
  })

  test("clamps minimum columns to 2", () => {
    const [firstA, secondA] = sigwinchToggleSize(2, 24)
    expect(firstA.cols).toBeGreaterThanOrEqual(2)
    expect(secondA.cols).toBe(2)

    const [firstB, secondB] = sigwinchToggleSize(1, 24)
    expect(firstB.cols).toBeGreaterThanOrEqual(2)
    expect(secondB.cols).toBeGreaterThanOrEqual(2)
  })

  test("rows pass through unchanged for both sizes regardless of column value", () => {
    const [first, second] = sigwinchToggleSize(120, 50)
    expect(first.rows).toBe(50)
    expect(second.rows).toBe(50)
  })
})

describe("isRetriableClose", () => {
  test("returns false for normal close (1000)", () => {
    expect(isRetriableClose(1000)).toBe(false)
  })

  test("returns false for session not found (1008)", () => {
    expect(isRetriableClose(1008)).toBe(false)
  })

  test("returns false for terminal overload (4000)", () => {
    expect(isRetriableClose(4000)).toBe(false)
  })

  test("returns true for abnormal close (1006)", () => {
    expect(isRetriableClose(1006)).toBe(true)
  })

  test("returns true for server error (1011)", () => {
    expect(isRetriableClose(1011)).toBe(true)
  })

  test("returns true for service restart (1012)", () => {
    expect(isRetriableClose(1012)).toBe(true)
  })

  test("returns true for try again later (1013)", () => {
    expect(isRetriableClose(1013)).toBe(true)
  })

  test("returns true for going away (1001)", () => {
    expect(isRetriableClose(1001)).toBe(true)
  })
})

describe("reconnectDelay", () => {
  test("returns 1s for first attempt", () => {
    expect(reconnectDelay(0)).toBe(1000)
  })

  test("returns 2s for second attempt", () => {
    expect(reconnectDelay(1)).toBe(2000)
  })

  test("returns 4s for third attempt", () => {
    expect(reconnectDelay(2)).toBe(4000)
  })

  test("caps at 16s", () => {
    expect(reconnectDelay(4)).toBe(16000)
  })

  test("caps for very large attempt numbers", () => {
    expect(reconnectDelay(100)).toBe(16000)
  })
})

describe("MAX_RECONNECT_ATTEMPTS", () => {
  test("is a positive integer", () => {
    expect(Number.isInteger(MAX_RECONNECT_ATTEMPTS)).toBe(true)
    expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0)
  })
})

describe("reconnect status messages", () => {
  test("reconnectingMessage includes attempt and max", () => {
    const msg = reconnectingMessage(2, 6)
    expect(msg).toContain("2")
    expect(msg).toContain("6")
  })

  test("reconnectedMessage returns non-empty string", () => {
    const msg = reconnectedMessage()
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).toContain("Reconnected")
  })

  test("reconnectFailedMessage returns non-empty string", () => {
    const msg = reconnectFailedMessage()
    expect(msg.length).toBeGreaterThan(0)
  })

  test("reconnectFailedMessage includes connection lost text", () => {
    const msg = reconnectFailedMessage()
    expect(msg).toContain("Connection lost")
  })
})

describe("existing exports still work", () => {
  test("WebSocketCloseError has code and reason", () => {
    const err = new WebSocketCloseError(1006, "abnormal")
    expect(err.code).toBe(1006)
    expect(err.reason).toBe("abnormal")
    expect(err.name).toBe("WebSocketCloseError")
    expect(err.message).toContain("1006")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WebSocketCloseError)
  })

  test("socketCloseIsError returns true for non-1000 codes", () => {
    expect(socketCloseIsError(1006)).toBe(true)
    expect(socketCloseIsError(1000)).toBe(false)
  })
})

describe("openTerminalWebSocket direct vs relay", () => {
  test("opens a direct local PTY socket (no workspaceId) without going through Workspace Relay", async () => {
    FakeWebSocket.connections = []

    await openTerminalWebSocket({
      serverUrl: "http://127.0.0.1:3001",
      ptyId: "pty_1",
      cursor: 7,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double implements only the API surface exercised by this test.
      webSocket: FakeWebSocket as typeof WebSocket,
    })

    expect(FakeWebSocket.connections).toEqual([{
      url: "ws://127.0.0.1:3001/api/wr/pty/pty_1/connect?cursor=7",
      protocols: undefined,
    }])
  })

  test("opens a cloud PTY socket through Workspace Relay with the Runtime Access Token as the WebSocket protocol", async () => {
    FakeWebSocket.connections = []

    await openTerminalWebSocket({
      serverUrl: "http://server.test",
      workspaceId: "ws_socket",
      directory: "workspace:ws_socket",
      ptyId: "pty_1",
      cursor: 7,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double implements only the API surface exercised by this test.
      webSocket: FakeWebSocket as typeof WebSocket,
      request: (async () =>
        Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_socket",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })) as typeof fetch,
    })

    expect(FakeWebSocket.connections).toEqual([{
      url: "wss://relay.example.test/workspaces/ws_socket/api/wr/pty/pty_1/connect?cursor=7&workspaceId=ws_socket&directory=workspace%3Aws_socket",
      protocols: ["claxedo-rat.rat_1"],
    }])
  })
})

describe("terminal runtime routing", () => {
  test("terminalPtyApiPath preserves suffix and runtime scope query", () => {
    expect(terminalPtyApiPath({
      suffix: "pty/with slash",
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
    })).toBe("/api/wr/pty/pty/with%20slash?workspaceId=ws_cloud&directory=workspace%3Aws_cloud")
  })

  test("loopback cloud PTY updates use Workspace Relay", async () => {
    const calls: string[] = []
    const client = createTerminalPtyClient({
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
      request: (async (input) => {
        calls.push(requestUrl(input))
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_cloud",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }) as typeof fetch,
      relayRequest: (async (input) => {
        calls.push(requestUrl(input))
        return Response.json({ ok: true })
      }) as typeof fetch,
    })

    await client.update("pty_1", { title: "Terminal" })

    expect(calls).toEqual([
      "http://127.0.0.1:3001/api/workspace/ws_cloud/connection",
      "https://relay.example.test/workspaces/ws_cloud/api/wr/pty/pty_1?workspaceId=ws_cloud&directory=workspace%3Aws_cloud",
    ])
  })

  test("loopback cloud terminal websocket opens through Workspace Relay", async () => {
    FakeWebSocket.urls = []

    await openTerminalWebSocket({
      serverUrl: "http://127.0.0.1:3001",
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
      ptyId: "pty_1",
      cursor: 12,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: test double implements only the API surface exercised by this test.
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
      request: (async () =>
        Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_cloud",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })) as typeof fetch,
    })

    expect(FakeWebSocket.urls).toEqual([
      "wss://relay.example.test/workspaces/ws_cloud/api/wr/pty/pty_1/connect?cursor=12&workspaceId=ws_cloud&directory=workspace%3Aws_cloud",
    ])
  })

  test("remote cloud terminal websocket preserves encoded path and directory", async () => {
    FakeWebSocket.urls = []

    await openTerminalWebSocket({
      serverUrl: "http://server.test",
      workspaceId: "ws_cloud",
      directory: "workspace:ws_cloud",
      ptyId: "pty/with slash",
      cursor: 12,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: test double implements only the API surface exercised by this test.
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
      request: (async () =>
        Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_cloud",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })) as typeof fetch,
    })

    expect(FakeWebSocket.urls).toEqual([
      "wss://relay.example.test/workspaces/ws_cloud/api/wr/pty/pty%2Fwith%20slash/connect?cursor=12&workspaceId=ws_cloud&directory=workspace%3Aws_cloud",
    ])
  })
})
