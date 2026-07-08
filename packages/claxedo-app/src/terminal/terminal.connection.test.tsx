import { describe, expect, test } from "bun:test"
import {
  openTerminalWebSocket,
  sigwinchToggleSize,
  socketCloseIsError,
  WebSocketCloseError,
} from "./terminal-connection"

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

describe("terminal connection", () => {
  describe("sigwinchToggleSize", () => {
    test("returns cols-1 then cols to force SIGWINCH", () => {
      const [first, second] = sigwinchToggleSize(80, 24)
      expect(first).toEqual({ cols: 79, rows: 24 })
      expect(second).toEqual({ cols: 80, rows: 24 })
    })

    test("rows unchanged across both sizes", () => {
      const [first, second] = sigwinchToggleSize(120, 50)
      expect(first.rows).toBe(50)
      expect(second.rows).toBe(50)
    })

    test("cols at minimum (2) stays at floor", () => {
      const [first, second] = sigwinchToggleSize(2, 24)
      expect(first.cols).toBeGreaterThanOrEqual(2)
      expect(second.cols).toBe(2)
    })

    test("cols below minimum is clamped to 2", () => {
      const [first, second] = sigwinchToggleSize(1, 24)
      expect(first.cols).toBeGreaterThanOrEqual(2)
      expect(second.cols).toBeGreaterThanOrEqual(2)
    })
  })

  describe("socketCloseIsError", () => {
    test("code 1000 (normal close) is not an error", () => {
      expect(socketCloseIsError(1000)).toBe(false)
    })

    test("abnormal close codes are errors", () => {
      expect(socketCloseIsError(1006)).toBe(true)
      expect(socketCloseIsError(1011)).toBe(true)
      expect(socketCloseIsError(1001)).toBe(true)
      expect(socketCloseIsError(4000)).toBe(true)
    })
  })

  describe("WebSocketCloseError", () => {
    test("has code and reason properties", () => {
      const error = new WebSocketCloseError(1008, "Session not found")
      expect(error.code).toBe(1008)
      expect(error.reason).toBe("Session not found")
      expect(error.message).toContain("1008")
    })

    test("instanceof Error", () => {
      const error = new WebSocketCloseError(1008, "Session not found")
      expect(error instanceof Error).toBe(true)
      expect(error instanceof WebSocketCloseError).toBe(true)
    })
  })

  describe("openTerminalWebSocket", () => {
    test("opens direct local PTY sockets without workspace relay", async () => {
      const sockets: Array<{ url: string; protocols?: string | string[] }> = []
      class FakeWebSocket {
        binaryType = ""
        readyState = 0
        constructor(url: string | URL, protocols?: string | string[]) {
          sockets.push({ url: String(url), protocols })
        }
      }

      await openTerminalWebSocket({
        serverUrl: "http://127.0.0.1:3001",
        ptyId: "pty_1",
        cursor: 7,
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        webSocket: FakeWebSocket as typeof WebSocket,
      })

      expect(sockets).toEqual([{
        url: "ws://127.0.0.1:3001/api/wr/pty/pty_1/connect?cursor=7",
        protocols: undefined,
      }])
    })

    test("opens cloud PTY sockets through Workspace Relay with Runtime Access Token protocol", async () => {
      const calls: string[] = []
      const sockets: Array<{ url: string; protocols?: string | string[] }> = []
      class FakeWebSocket {
        binaryType = ""
        readyState = 0
        constructor(url: string | URL, protocols?: string | string[]) {
          sockets.push({ url: String(url), protocols })
        }
      }

      await openTerminalWebSocket({
        serverUrl: "http://server.test",
        workspaceId: "ws_socket",
        directory: "workspace:ws_socket",
        ptyId: "pty_1",
        cursor: 7,
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        webSocket: FakeWebSocket as typeof WebSocket,
        request: async (input) => {
          calls.push(requestUrl(input))
          return Response.json({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_socket",
            role: "owner",
            relayUrl: "https://relay.example.test",
            runtimeAccessToken: "rat_1",
            tokenExpiresAt: Date.now() + 120_000,
          })
        },
      })

      expect(calls).toEqual(["http://server.test/api/workspace/ws_socket/connection"])
      expect(sockets).toEqual([{
        url: "wss://relay.example.test/workspaces/ws_socket/api/wr/pty/pty_1/connect?cursor=7&workspaceId=ws_socket&directory=workspace%3Aws_socket",
        protocols: ["claxedo-rat.rat_1"],
      }])
    })
  })
})
