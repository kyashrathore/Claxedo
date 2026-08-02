// Minimal public resolver Worker for the CF-relay re-evaluation bench. Stands in
// for the control-plane /internal/relay resolver: maps every workspace to the
// one configured bench target and never revokes. Config via Worker vars:
//   TARGET_BASE_URL   — the Daytona sandbox base (no path, no query)
//   TARGET_TOKEN      — Daytona preview token, forwarded upstream as a header
//   RESOLVER_TOKEN    — Bearer the relay must present (optional)
//   ACCESS_MODE       — "cloud" (default, dial-out) or "user-hosted" (dial-in)
//
// ACCESS_MODE selects the relay's routing:
//   cloud        → access:"cloud"/backing:"cloud-vm"  → relay DIALS OUT to
//                  TARGET_BASE_URL (the Daytona preview URL), the June path.
//   user-hosted  → access:"user-hosted"/backing:"local-worktree" → relay routes
//                  the client into the registered host tunnel (dial-in). No
//                  baseUrl/upstreamHeaders are needed: the sandbox agent reaches
//                  its own localhost echo server, so the relay never dials the
//                  sandbox. The resolver still returns a baseUrl (harmless,
//                  unused on this path) so the target contract stays populated.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accessMode = env.ACCESS_MODE === "user-hosted" ? "user-hosted" : "cloud";
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "bench-resolver-worker", accessMode });
    }
    if (env.RESOLVER_TOKEN) {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.RESOLVER_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname.endsWith("/target")) {
      const workspaceId = url.searchParams.get("workspaceId") ?? "ws_bench";
      const hostId = url.searchParams.get("hostId") ?? "host_bench";
      if (accessMode === "user-hosted") {
        return Response.json({
          workspaceId, hostId,
          baseUrl: env.TARGET_BASE_URL ?? "http://unused.local",
          access: "user-hosted",
          backing: "local-worktree",
        });
      }
      return Response.json({
        workspaceId, hostId,
        baseUrl: env.TARGET_BASE_URL,
        access: "cloud",
        backing: "cloud-vm",
        ...(env.TARGET_TOKEN ? { upstreamHeaders: { "x-daytona-preview-token": env.TARGET_TOKEN } } : {}),
      });
    }
    if (url.pathname.endsWith("/revocation")) return Response.json({ active: true });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
