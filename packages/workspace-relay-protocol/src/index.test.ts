import { describe, expect, test } from "bun:test"
import {
  TUNNEL_PROTOCOL_VERSION,
  isTunnelMessage,
  makeTunnelPong,
  validateTunnelMessage,
  type TunnelError,
  type TunnelHttpRequest,
  type TunnelHttpResponseChunk,
  type TunnelHttpResponseEnd,
  type TunnelHttpResponseFlow,
  type TunnelHttpResponseStart,
  type TunnelWsClose,
  type TunnelWsFrame,
  type TunnelWsOpen,
} from "./index"

describe("workspace relay protocol", () => {
  test("recognizes versioned tunnel messages", () => {
    expect(isTunnelMessage({
      type: "http.response.chunk",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      body_base64: "aGVsbG8=",
    } satisfies TunnelHttpResponseChunk)).toBe(true)

    expect(isTunnelMessage({
      type: "http.response.chunk",
      protocol: 0,
      request_id: "req_1",
      body_base64: "aGVsbG8=",
    })).toBe(false)
  })

  test("reports protocol version mismatches distinctly from invalid messages", () => {
    expect(validateTunnelMessage({
      type: "http.response.chunk",
      protocol: 0,
      request_id: "req_1",
      body_base64: "aGVsbG8=",
    })).toEqual({
      ok: false,
      reason: "protocol_mismatch",
      expected_protocol: TUNNEL_PROTOCOL_VERSION,
      actual_protocol: 0,
      type: "http.response.chunk",
    })

    expect(validateTunnelMessage({
      protocol: TUNNEL_PROTOCOL_VERSION,
      type: "unknown.message",
    })).toEqual({
      ok: false,
      reason: "invalid",
    })
  })

  test("recognizes binary WebSocket frame messages", () => {
    expect(isTunnelMessage({
      type: "ws.frame",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "ch_1",
      data_base64: Buffer.from([0, 255]).toString("base64"),
      binary: true,
    } satisfies TunnelWsFrame)).toBe(true)
  })

  test("recognizes HTTP response flow-control messages", () => {
    expect(isTunnelMessage({
      type: "http.response.flow",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      paused: true,
      reason: "slow_consumer",
    } satisfies TunnelHttpResponseFlow)).toBe(true)
  })

  test("recognizes fully-shaped HTTP request and response messages", () => {
    expect(isTunnelMessage({
      type: "http.request",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      workspace_id: "ws_1",
      method: "POST",
      path: "/api/wr/message",
      headers: { "content-type": "application/json" },
      body_base64: "e30=",
      end: true,
    } satisfies TunnelHttpRequest)).toBe(true)

    expect(isTunnelMessage({
      type: "http.response.start",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      status: 202,
      headers: { "content-type": "application/json" },
    } satisfies TunnelHttpResponseStart)).toBe(true)

    expect(isTunnelMessage({
      type: "http.response.end",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
    } satisfies TunnelHttpResponseEnd)).toBe(true)
  })

  test("recognizes WebSocket open messages", () => {
    expect(isTunnelMessage({
      type: "ws.open",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "ch_1",
      workspace_id: "ws_1",
      path: "/api/wr/events",
      headers: { origin: "https://app.claxedo.com" },
    } satisfies TunnelWsOpen)).toBe(true)
  })

  test("recognizes tunnel error and close messages", () => {
    expect(isTunnelMessage({
      type: "error",
      protocol: TUNNEL_PROTOCOL_VERSION,
      request_id: "req_1",
      code: "host_tunnel_http_failed",
      message: "failed",
    } satisfies TunnelError)).toBe(true)

    expect(isTunnelMessage({
      type: "ws.close",
      protocol: TUNNEL_PROTOCOL_VERSION,
      channel_id: "ch_1",
      code: 1000,
      reason: "done",
    } satisfies TunnelWsClose)).toBe(true)
  })

  test("builds heartbeat pong frames from ping frames", () => {
    expect(makeTunnelPong({
      type: "ping",
      protocol: TUNNEL_PROTOCOL_VERSION,
      id: "ping_1",
      sent_at: 10,
    }, 20)).toEqual({
      type: "pong",
      protocol: TUNNEL_PROTOCOL_VERSION,
      id: "ping_1",
      sent_at: 10,
      received_at: 20,
    })
  })

  test("rejects malformed payloads for each tunnel message shape", () => {
    const invalid = [
      { type: "ping", protocol: TUNNEL_PROTOCOL_VERSION, id: "", sent_at: 10 },
      { type: "pong", protocol: TUNNEL_PROTOCOL_VERSION, id: "ping_1", sent_at: 10, received_at: "20" },
      {
        type: "http.request",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: "req_1",
        workspace_id: "ws_1",
        method: "POST",
        path: "/api/wr/message",
        headers: { authorization: 123 },
        end: true,
      },
      {
        type: "http.request",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: "req_1",
        workspace_id: "ws_1",
        method: "POST",
        path: "/api/wr/message",
        headers: {},
        body_base64: "not base64",
        end: true,
      },
      {
        type: "http.response.start",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: "req_1",
        status: 99,
        headers: {},
      },
      {
        type: "http.response.chunk",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: "req_1",
        body_base64: "not base64",
      },
      { type: "http.response.end", protocol: TUNNEL_PROTOCOL_VERSION, request_id: 1 },
      {
        type: "http.response.flow",
        protocol: TUNNEL_PROTOCOL_VERSION,
        request_id: "req_1",
        paused: true,
        reason: "paused_by_magic",
      },
      {
        type: "ws.open",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: "ch_1",
        workspace_id: "ws_1",
        path: "/api/wr/events",
        headers: [],
      },
      {
        type: "ws.frame",
        protocol: TUNNEL_PROTOCOL_VERSION,
        channel_id: "ch_1",
        data_base64: "not base64",
        binary: true,
      },
      { type: "ws.close", protocol: TUNNEL_PROTOCOL_VERSION, channel_id: "ch_1", code: 70_000 },
      { type: "error", protocol: TUNNEL_PROTOCOL_VERSION, code: "host_tunnel_http_failed" },
    ]

    for (const message of invalid) {
      expect(validateTunnelMessage(message)).toEqual({
        ok: false,
        reason: "invalid",
      })
    }
  })
})
