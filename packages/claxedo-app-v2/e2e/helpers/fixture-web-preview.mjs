import { createServer, preview } from "vite"

const [outDir, rawPort, backendUrl, relayUrl] = process.argv.slice(2)
if (!outDir || !rawPort || !backendUrl) throw new Error("Fixture preview requires output, port, and backend")

// Test transport gateway, not a BetterAuth implementation: the HttpOnly cookie
// carries the fixture issuer's real JWT. The backend still verifies its signature
// and enforces the production private-session authority on every request.
const dev = process.env.CLAXEDO_E2E_FIXTURE_DEV === "1"
const config = {
  configFile: "vite.cloud.config.ts",
  build: { outDir },
  preview: { host: "127.0.0.1", port: Number(rawPort), strictPort: true },
  server: { host: "127.0.0.1", port: Number(rawPort), strictPort: true },
  plugins: [{
    name: "signed-fixture-auth-gateway",
    configResolved(config) {
      const proxy = Object.fromEntries(Object.entries(config.server.proxy ?? {}).map(([route, options]) => [
        route,
        {
          ...options,
          target: backendUrl,
          configure(proxy) {
            if (!relayUrl) return
            const authorize = (outgoing, request) => {
              const token = request.headers.cookie?.split(";").map((part) => part.trim())
                .find((part) => part.startsWith("claxedo_fixture_jwt="))?.slice("claxedo_fixture_jwt=".length)
              outgoing.removeHeader("cookie")
              if (token && !request.headers.authorization) outgoing.setHeader("authorization", "Bearer " + token)
              outgoing.setHeader("x-forwarded-for", "203.0.113.10")
            }
            proxy.on("proxyReq", authorize)
            proxy.on("proxyReqWs", authorize)
          },
        },
      ]))
      if (relayUrl) proxy["/workspaces"] = {
        target: relayUrl,
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const stripCookie = (outgoing) => outgoing.removeHeader("cookie")
          proxy.on("proxyReq", stripCookie)
          proxy.on("proxyReqWs", stripCookie)
        },
      }
      config.preview.proxy = proxy
      config.server.proxy = proxy
    },
  }],
}
const server = dev ? await createServer(config) : await preview(config)
if (dev) await server.listen()
console.log("Local: http://" + (relayUrl ? "app.localhost" : "127.0.0.1") + ":" + rawPort)
