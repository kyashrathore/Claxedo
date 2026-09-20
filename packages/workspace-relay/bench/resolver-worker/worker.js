// Minimal public resolver Worker for the CF-relay re-evaluation bench. Stands in
// for the control-plane /internal/relay resolver: maps every workspace to the
// one configured bench target and never revokes. Config via Worker vars:
//   TARGET_BASE_URL   — the Daytona sandbox base (no path, no query)
//   TARGET_TOKEN      — Daytona preview token, forwarded upstream as a header
//   RESOLVER_TOKEN    — Bearer the relay must present (optional)
//   TARGET_BACKING    — "cloud-vm" (default, dial-out) or "local-worktree"
//
// TARGET_BACKING selects the relay's routing:
//   cloud-vm        → relay DIALS OUT to TARGET_BASE_URL (the Daytona preview
//                     URL), the June path.
//   local-worktree  → relay routes the client into the registered host tunnel
//                     (dial-in). No baseUrl/upstreamHeaders are needed: the
//                     sandbox agent reaches its own localhost echo server, so
//                     the relay never dials the sandbox. The resolver still
//                     returns a baseUrl (harmless, unused on this path) so the
//                     target contract stays populated.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const backing = env.TARGET_BACKING === "local-worktree" ? "local-worktree" : "cloud-vm";
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "bench-resolver-worker", backing });
    }
    if (env.RESOLVER_TOKEN) {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${env.RESOLVER_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname.endsWith("/target")) {
      const workspaceId = url.searchParams.get("workspaceId") ?? "ws_bench";
      const hostId = url.searchParams.get("hostId") ?? "host_bench";
      if (backing === "local-worktree") {
        return Response.json({
          workspaceId, hostId,
          baseUrl: env.TARGET_BASE_URL ?? "http://unused.local",
          backing: "local-worktree",
        });
      }
      return Response.json({
        workspaceId, hostId,
        baseUrl: env.TARGET_BASE_URL,
        backing: "cloud-vm",
        ...(env.TARGET_TOKEN ? { upstreamHeaders: { "x-daytona-preview-token": env.TARGET_TOKEN } } : {}),
      });
    }
    if (url.pathname.endsWith("/revocation")) return Response.json({ active: true });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
