/**
 * The relay as a `claxedo connect` host's serving loop sees it: a WebSocket
 * endpoint at `/host-tunnels/<hostId>` that admits every dial and records the
 * Host Tunnel Token and workspace ids each socket presented, so a test reads
 * back what the host claimed to serve and whether the tunnel is still open.
 * Bun's server: the CLI's tests run under bun.
 */

export type RelaySocket = { token: string; workspaceIds: string[]; closed: boolean }

export function relayStub() {
  const sockets: RelaySocket[] = []
  const server = Bun.serve<RelaySocket>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/host-tunnels/")) return new Response("not a tunnel", { status: 404 })
      const data: RelaySocket = {
        token: (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
        workspaceIds: url.searchParams.getAll("workspaceId"),
        closed: false,
      }
      return bun.upgrade(request, { data }) ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws.data)
      },
      message() {},
      close(ws) {
        ws.data.closed = true
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    sockets,
    open: () => sockets.filter((socket) => !socket.closed),
    stop: () => server.stop(true),
  }
}

export type RelayStub = ReturnType<typeof relayStub>

export async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
