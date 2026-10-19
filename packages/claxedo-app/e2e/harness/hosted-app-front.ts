import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, request as httpsRequest } from "node:https"
import { X509Certificate, createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { appBundleFile } from "../../../harness/e2e/harness/local-app-bundle"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import { listenOnLoopback } from "../../../harness/e2e/harness/ports"
import type { HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import { publishDeployment, readPublishedDeployment } from "../../published-deployment"
import type { PublishedDeployment } from "../../src/server/published-deployment"
import { forward, forwardUpgrade } from "./proxy"
import { pagesHeaders, respondShaped, type FrontShaping } from "./front-shaping"
import type { TlsFront } from "./tls-front"
import { RELAY_PATH_PREFIX, publicOriginRoute } from "../../../claxedo-server/scripts/deploy/public-origin"
import { shellPreloadLinks } from "../../../claxedo-server/scripts/deploy/shell-preloads"
import { carriesSessionCookie } from "../../../claxedo-server/src/platform/auth/session-cookie"

function relayTarget(url: string, relayUrl: string) {
  return new URL(url.slice(RELAY_PATH_PREFIX.length), relayUrl)
}

export async function startHostedAppFront(input: { port: number; distDir: string; hosted: HostedStack; shaping?: FrontShaping }): Promise<TlsFront & { controlPlaneRequests(): readonly string[] }> {
  const certificate = await fs.readFile(input.hosted.certificate)
  const worker = new URL(input.hosted.workerOrigin)
  const tls = { cert: certificate, key: await fs.readFile(input.hosted.credentials.key) }
  const forwarded: string[] = []
  const answerFor = pagesHeaders(input.distDir)
  let deployment: PublishedDeployment | undefined
  const published = async (asset: Response, pathname: string, cookie: string | undefined) => {
    if (path.extname(pathname) && pathname !== "/index.html") return asset
    if (!deployment) throw new Error("the app front served its shell before it read the deployment")
    const shell = new Response(publishDeployment(await asset.text(), deployment), { status: asset.status, headers: asset.headers })
    if (carriesSessionCookie(cookie)) shell.headers.set("link", shellPreloadLinks(pathname))
    return shell
  }
  const held = (run: () => void) => {
    const delay = input.shaping?.apiDelayMs() ?? 0
    if (delay > 0) setTimeout(run, delay)
    else run()
  }
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", input.hosted.workerUrl).pathname
    const route = publicOriginRoute(pathname)
    if (route === "relay") {
      const target = relayTarget(request.url ?? "/", input.hosted.relayUrl)
      request.url = `${target.pathname}${target.search}`
      return held(() => forward(request, response, target))
    }
    if (route === "control-plane") {
      forwarded.push(`${request.method} ${pathname}`)
      const relay = () => {
        const upstream = httpsRequest({ hostname: worker.hostname, port: worker.port, method: request.method,
          path: request.url, headers: request.headers, ca: certificate, agent: false }, (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(response)
        })
        upstream.on("error", (error) => response.headersSent ? response.destroy(error) : response.writeHead(502).end(error.message))
        request.pipe(upstream)
      }
      return held(relay)
    }
    const bundled = await appBundleFile(input.distDir, pathname, request.headers.accept?.includes("text/html") ?? false)
    if (!bundled) { response.writeHead(404).end(); return }
    const asset = await published(bundled, pathname, request.headers.cookie)
    if (input.shaping) return respondShaped(request, response, path.extname(pathname) ? pathname : "/index.html", asset, answerFor(path.extname(pathname) ? pathname : "/index.html"), input.shaping)
    response.writeHead(asset.status, Object.fromEntries(asset.headers)).end(Buffer.from(await asset.arrayBuffer()))
  }
  const servers = [createServer(tls, serve), createServer(tls, serve)]
  for (const server of servers) {
    server.on("upgrade", (request, socket, head) => {
      if (publicOriginRoute(new URL(request.url ?? "/", input.hosted.workerUrl).pathname) !== "relay") {
        socket.destroy()
        return
      }
      const target = relayTarget(request.url ?? "/", input.hosted.relayUrl)
      request.url = `${target.pathname}${target.search}`
      held(() => forwardUpgrade(request, socket, head, target))
    })
  }
  await listenOnLoopback(servers[0], input.port)
  await new Promise<void>((resolve, reject) => {
    servers[1].once("error", reject)
    servers[1].listen(input.port, "::1", resolve)
  })
  deployment = await readPublishedDeployment(input.hosted.workerUrl, (url) => hostedFetch(input.hosted, new URL(url).pathname))
  const spki = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })
  return {
    url: input.hosted.workerUrl,
    controlPlaneRequests: () => [...forwarded],
    trust: { caPath: input.hosted.certificate, spki: createHash("sha256").update(spki).digest("base64") },
    close: async () => {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    },
  }
}
