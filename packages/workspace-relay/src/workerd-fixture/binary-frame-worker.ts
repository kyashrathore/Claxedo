/**
 * Fixture worker for `relay-workerd-binary.test.ts`. Bundled by esbuild and run
 * on REAL workerd via miniflare, because the hazard it covers is invisible to
 * the hand-rolled socket doubles in `cloudflare.test.ts`: what the runtime hands
 * a message handler as `event.data` is a workerd behavior, not ours.
 *
 * The whole WebSocket round-trip happens INSIDE workerd and the result comes
 * back over plain HTTP. That is not incidental — Bun's `ws` shim cannot drive
 * miniflare's WebSocket client (it has no `upgrade` event), so a test that
 * opened the socket from the test process would hang rather than fail. Keeping
 * the socket inside the runtime also means the frame crosses a genuine workerd
 * WebSocket rather than a loopback in the harness.
 *
 * Runtime globals are structurally typed here rather than pulled from
 * `@cloudflare/workers-types`, matching how the rest of this package models the
 * Cloudflare surface (see the `WorkspaceRelayDurableObject*` types in
 * cloudflare.ts) — the package deliberately carries no workers-types dependency.
 *
 * Deliberately minimal: it exercises the two frame decoders through the same
 * both-paths shape the room uses (`addEventListener` when not hibernating,
 * `webSocketMessage` when hibernating) rather than booting the whole relay,
 * which would need JWKS, a resolver, and PEMs to reach the frame path at all.
 */
import { relayFrameDiagnostics } from "../cloudflare"

type FixtureSocket = {
  accept: () => void
  send: (message: string | ArrayBuffer | Uint8Array) => void
  close: (code?: number, reason?: string) => void
  binaryType?: string
  addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void,
  ) => void
}

type FixtureState = { acceptWebSocket: (socket: FixtureSocket) => void }

type FixtureNamespace = {
  idFromName: (name: string) => unknown
  get: (id: unknown) => { fetch: (request: Request) => Promise<Response> }
}

const socketPair = () => {
  const pair = new (globalThis as unknown as {
    WebSocketPair: new () => { 0: FixtureSocket; 1: FixtureSocket }
  }).WebSocketPair()
  return { client: pair[0], server: pair[1] }
}

const upgradeResponse = (socket: FixtureSocket) =>
  new Response(null, { status: 101, webSocket: socket } as ResponseInit & { webSocket: FixtureSocket })

export class BinaryFrameRoom {
  constructor(private state: FixtureState) {}

  async fetch(request: Request) {
    const { client, server } = socketPair()
    if (new URL(request.url).searchParams.get("mode") === "hibernate") {
      this.state.acceptWebSocket(server)
    } else {
      server.accept()
      server.addEventListener("message", (event) => {
        void this.report(server, event.data)
      })
    }
    return upgradeResponse(client)
  }

  /** Hibernation delivery path — survives eviction, so no listener exists. */
  async webSocketMessage(socket: FixtureSocket, message: unknown) {
    await this.report(socket, message)
  }

  async webSocketClose() {}

  private async report(socket: FixtureSocket, data: unknown) {
    const diagnostics = await relayFrameDiagnostics(data)
    socket.send(JSON.stringify({
      // What workerd actually handed us, so a failure says WHY rather than just
      // "expected bytes, got nothing".
      runtimeType: data === null || data === undefined
        ? String(data)
        : (data as { constructor?: { name?: string } }).constructor?.name ?? typeof data,
      binaryType: socket.binaryType,
      ...diagnostics,
    }))
  }
}

export default {
  async fetch(request: Request, env: { ROOM: FixtureNamespace }) {
    const url = new URL(request.url)
    const mode = url.searchParams.get("mode") ?? "listener"
    // Payload arrives as base64 so the test owns the exact bytes under test.
    const payload = Uint8Array.from(atob(url.searchParams.get("payload") ?? ""), (c) => c.charCodeAt(0))

    const upgrade = await env.ROOM.get(env.ROOM.idFromName(mode)).fetch(
      new Request(`https://relay.test/ws?mode=${mode}`, { headers: { Upgrade: "websocket" } }),
    )
    const socket = (upgrade as Response & { webSocket?: FixtureSocket }).webSocket
    if (!socket) return Response.json({ error: "no webSocket on upgrade response" }, { status: 500 })
    socket.accept()

    const report = new Promise<unknown>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          resolve(JSON.parse(String(event.data)))
        } catch (err) {
          reject(err)
        }
      })
      socket.addEventListener("close", () => reject(new Error("socket closed before reporting")))
      socket.addEventListener("error", () => reject(new Error("socket errored before reporting")))
    })

    socket.send(payload)
    try {
      return Response.json(await report)
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    } finally {
      try {
        socket.close(1000, "done")
      } catch {
        // Best-effort teardown.
      }
    }
  },
}
