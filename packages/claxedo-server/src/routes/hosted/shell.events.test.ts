import { afterEach, expect, test, vi } from "vitest"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime/contracts"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { HostedShellRoutes } from "./shell"

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

const verifier = async () => ({
  mode: "signed" as const,
  user: { subject: "user_owner", tokenIdentifier: "https://example.issuer.dev|user_owner", issuer: "https://example.issuer.dev" },
})

afterEach(() => {
  vi.useRealTimers()
})

test("the hosted cp/events stream beats on the shared event stream heartbeat", async () => {
  vi.useFakeTimers()
  const response = await HostedShellRoutes({ authConfig: signedConfig, verifier }).request("http://cp.test/api/cp/events", {
    headers: { authorization: "Bearer token-owner" },
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  expect(decoder.decode((await reader.read()).value)).toBe('id: 0\ndata: {"type":"heartbeat"}\n\n')

  let beat: string | undefined
  void reader.read().then(({ value }) => (beat = decoder.decode(value)))
  await vi.advanceTimersByTimeAsync(EVENT_STREAM_HEARTBEAT_MS - 1)
  expect(beat).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(beat).toBe('data: {"type":"heartbeat"}\n\n')
  await reader.cancel()
})

test("a room-bridged hosted cp/events stream beats 6 times a minute, reauthorizes twice, and ends within one reauthorization of a revoke", async () => {
  vi.useFakeTimers()
  const socket = Object.assign(new EventTarget(), { accept() {}, send() {}, close() {} })
  const liveSyncRoom = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Object.assign(new Response(null), { webSocket: socket }) }),
  }
  let revoked = false
  let orgReads = 0
  const response = await HostedShellRoutes({
    authConfig: signedConfig,
    verifier: async () => {
      if (revoked) throw new Error("token revoked")
      return verifier()
    },
    resolveOrgId: async () => {
      orgReads += 1
      return "org_internal_acme"
    },
    liveSyncRoom,
  }).request("http://cp.test/api/cp/events", { headers: { authorization: "Bearer token-owner" } })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let ended = false
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      frames.push(decoder.decode(value))
    }
    ended = true
  })()
  await vi.advanceTimersByTimeAsync(0)
  expect(frames).toEqual(['id: 0\ndata: {"type":"heartbeat"}\n\n'])
  expect(orgReads).toBe(1)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(frames.slice(1)).toEqual(Array.from({ length: 6 }, () => 'data: {"type":"heartbeat"}\n\n'))
  expect(orgReads - 1).toBe(2)

  revoked = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ended).toBe(true)
})
