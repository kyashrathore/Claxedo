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
// both on 127.0.0.1 by construction), the unsigned-local shortcut would otherwise swallow
// every control-plane request. `isLoopbackLocalRequest` fails closed on any
// forwarded-client header (`FORWARDED_CLIENT_HEADERS`): forwarding destroys the direct
// socket-to-client relationship unsigned-local trust is built on, so a request carrying
// one is never treated as local no matter what its socket peer is. This launcher is
// exactly that front door — the reverse proxy a production deployment runs in front of
// claxedo-server — stamping a genuine non-loopback client IP via `X-Forwarded-For` on
// every proxied request, the same signal a real nginx/Cloudflare edge adds. No
// claxedo-server or claxedo-app product source is modified by this.
//
// Scope of that stamp: it covers the SAME-ORIGIN requests a page makes through this dev
// server (`/api/...`), which is the lane the spec's own in-page product calls take. The
// app's own control-plane calls resolve `VITE_CLAXEDO_SERVER_URL` into an ABSOLUTE base
// (`src/platform/api/api.ts`'s `getClaxedoServerUrl`) and therefore reach the backend
// directly, without passing through this proxy.
import { createServer } from "vite"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Build environment is the spawner's to supply, from the one owner every e2e
// vite launcher reads (`e2e/auth-mode.ts`'s `e2eAppViteEnvironment`): this file
// is JavaScript precisely so `node` can run it without a TypeScript loader, so
// it inherits that environment rather than importing it.
const backendUrl = process.env.VITE_CLAXEDO_SERVER_URL
if (!backendUrl) throw new Error("VITE_CLAXEDO_SERVER_URL is required")
const port = Number(process.env.PORT)
if (!port) throw new Error("PORT is required")

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const FORWARDED_CLIENT_IP = "203.0.113.10" // TEST-NET-3 (RFC 5737), never a real client.

// `vite.cloud.config.ts` is TypeScript and imports further TypeScript modules
// (`./vite.browser-auth`), which a bare `node` import cannot resolve — vite loads and
// transpiles its own config file, so this launcher hands vite the real config path and
// layers the forwarded-client header on as a plugin. `configResolved` runs while
// `createServer` resolves the config, before it builds the proxy middleware from
// `config.server.proxy`, so every route in the config's own proxy list is covered
// without this file restating that list.
const forwardedClientPlugin = {
  name: "live-user-hosted-relay:forwarded-client",
  configResolved(config) {
    for (const entry of Object.values(config.server.proxy ?? {})) {
      entry.configure = (proxy) => {
        proxy.on("proxyReq", (proxyReq) => {
          proxyReq.setHeader("x-forwarded-for", FORWARDED_CLIENT_IP)
        })
      }
    }
  },
}

const server = await createServer({
  root: appDir,
  configFile: path.join(appDir, "vite.cloud.config.ts"),
  plugins: [forwardedClientPlugin],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
})
await server.listen()
console.log(JSON.stringify({ ready: true, port }))
