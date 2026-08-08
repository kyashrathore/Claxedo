// Dedicated dev-server launcher for `live-user-hosted-relay.spec.ts` ONLY. Reuses the
// real `vite.cloud.config.ts` (same plugins, aliases, proxy route list) but layers one
// additive change: every proxied request gets a real, non-loopback `X-Forwarded-For`
// header.
//
// Why this is needed (not a workaround, a real product code path): claxedo-server's
// `/api/claxedo/bootstrap` route (packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts) takes
// the LOCAL, unsigned bootstrap path for ANY request whose real socket peer is loopback
// (`isLoopbackLocalRequest`, packages/claxedo-server-core/src/platform/http/peer-address.ts)
// REGARDLESS of a valid bearer token being present — this is deliberate (desktop/local
// dev shortcut). A workspace's real `kind: "user-hosted"` value, however, is ONLY present
// in the SIGNED bootstrap body (`signedBootstrapBody` -> `services.authority.
// listWorkspaces(auth)` -> `signedBootstrapProjects`, reading `row.access`) — the local
// body's project scan reports the raw `Workspace.kind` (`"local"|"cloud"` only, from
// `workspace-store.ts`), which the client's `sessionWorkspaceRuntimeRef` resolver reads
// as `signedKind` and therefore never sees "user-hosted" through the local path. Since
// this whole spec necessarily runs over loopback (its dedicated backend and frontend are
// both on 127.0.0.1 by construction), and `isLoopbackLocalRequest` itself documents the
// escape hatch ("Loopback peer + forwarded marker = a local reverse proxy fronting
// external traffic. Trust the proxy's client claim over the socket"), this launcher
// exercises that REAL, intentional code path: it acts as the "local reverse proxy" a
// production deployment would actually have in front of claxedo-server, stamping a
// genuine non-loopback client IP via `X-Forwarded-For` on every proxied request — the
// same signal a real nginx/Cloudflare front door would add. No claxedo-server or
// claxedo-app product source is modified by this.
import { createServer } from "vite"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const backendUrl = process.env.VITE_CLAXEDO_SERVER_URL
if (!backendUrl) throw new Error("VITE_CLAXEDO_SERVER_URL is required")
const port = Number(process.env.PORT)
if (!port) throw new Error("PORT is required")

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const configUrl = pathToFileURL(path.join(appDir, "vite.cloud.config.ts")).href
const configModule = await import(configUrl)
const configFactory = configModule.default
const baseConfig = typeof configFactory === "function"
  ? await configFactory({ mode: "development", command: "serve" })
  : configFactory

const FORWARDED_CLIENT_IP = "203.0.113.10" // TEST-NET-3 (RFC 5737), never a real client.

for (const entry of Object.values(baseConfig.server?.proxy ?? {})) {
  entry.configure = (proxy) => {
    proxy.on("proxyReq", (proxyReq) => {
      proxyReq.setHeader("x-forwarded-for", FORWARDED_CLIENT_IP)
    })
  }
}

const server = await createServer({
  ...baseConfig,
  root: appDir,
  configFile: false,
  server: {
    ...baseConfig.server,
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
})
await server.listen()
console.log(JSON.stringify({ ready: true, port }))
