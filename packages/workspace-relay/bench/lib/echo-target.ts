// A minimal HTTP + WebSocket echo runtime used as the LOCAL target for the
// loadgen dry-run gate. It plays the role a Daytona/CF sandbox runtime plays in
// cloud rows: HTTP GET /api/wr/health returns fast; a WS at
// /api/claxedo/pty/pty_1/connect echoes every frame back. It does NOT validate
// the forwarded Relay Host Token — like a real runtime behind the trust
// boundary, it trusts whatever the relay hands it.

export type EchoTarget = {
  url: string
  wsUrl: string
  port: number
  stop: () => void
}

export type EchoTargetConfig = {
  port?: number
  hostname?: string
  // Artificial delay (ms) before completing the WS upgrade / HTTP response, to
  // emulate a slow cross-provider handshake when probing locally. Default 0.
  handshakeDelayMs?: number
}

type EchoSocketData = { kind: "echo" }

export function startEchoTarget(config: EchoTargetConfig = {}): EchoTarget {
  const hostname = config.hostname ?? "127.0.0.1"
  const delay = config.handshakeDelayMs ?? 0
  const server = Bun.serve<EchoSocketData>({
    port: config.port ?? 0,
    hostname,
    async fetch(request, srv) {
      const url = new URL(request.url)
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (delay > 0) await Bun.sleep(delay)
        if (srv.upgrade(request, { data: { kind: "echo" } })) return
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/api/wr/health" || url.pathname === "/health") {
        return Response.json({ ok: true, service: "bench-echo-target", path: url.pathname })
      }
      // Echo body + a small marker for HTTP overhead probes.
      const body = await request.text()
      return new Response(body.length ? body : "echo", {
        headers: { "content-type": "text/plain" },
      })
    },
    websocket: {
      message(ws, message) {
        ws.send(message)
      },
    },
  })
  const port = server.port ?? 0
  return {
    url: `http://${hostname}:${port}`,
    wsUrl: `ws://${hostname}:${port}`,
    port,
    stop: () => server.stop(true),
  }
}
