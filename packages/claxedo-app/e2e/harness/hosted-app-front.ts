import { createSecureServer } from "node:http2"
import { request as httpsRequest } from "node:https"
import type { Socket } from "node:net"
import { X509Certificate, createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { appBundleFile } from "../../../harness/e2e/harness/local-app-bundle"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import { listenOnIpv6Loopback, listenOnLoopback } from "../../../harness/e2e/harness/ports"
import type { HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import { publishDeployment, readPublishedDeployment } from "../../published-deployment"
import type { PublishedDeployment } from "../../src/server/published-deployment"
import { abortResponse, answerHeaders, forward, forwardUpgrade, forwardedHeaders, type FrontRequest, type FrontResponse } from "./proxy"
import { pagesHeaders, respondShaped, type FrontShaping } from "./front-shaping"
import type { TlsFront } from "./tls-front"
import { RELAY_PATH_PREFIX, publicOriginRoute } from "../../../claxedo-server/scripts/deploy/public-origin"
import { shellDocument, type ShellDocument } from "../../../claxedo-server/scripts/deploy/shell-document"

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
  const published = async (asset: Response, document: ShellDocument) => {
    if (!deployment) throw new Error("the app front served a document before it read the deployment")
    const shell = new Response(publishDeployment(await asset.text(), deployment), { status: asset.status, headers: asset.headers })
    if (document.link) shell.headers.set("link", document.link)
    return shell
  }
  const held = (run: () => void) => {
    const delay = input.shaping?.apiDelayMs() ?? 0
    if (delay > 0) setTimeout(run, delay)
    else run()
  }
  const serve = async (request: FrontRequest, response: FrontResponse) => {
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
          path: request.url, headers: forwardedHeaders(request), ca: certificate, agent: false }, (reply) => {
          response.writeHead(reply.statusCode ?? 502, answerHeaders(reply.headers))
          reply.pipe(response)
        })
        upstream.on("error", (error) => abortResponse(response, error))
        response.on("close", () => upstream.destroy())
        request.pipe(upstream)
      }
      return held(relay)
    }
    const document = path.extname(pathname) ? undefined : shellDocument(pathname, request.headers.cookie)
    const served = document?.path ?? pathname
    const bundled = await appBundleFile(input.distDir, served, request.headers.accept?.includes("text/html") ?? false)
    if (!bundled) { response.writeHead(404).end(); return }
    const asset = document ? await published(bundled, document) : bundled
    if (input.shaping) return respondShaped(request, response, served, asset, answerFor(served), input.shaping)
    response.writeHead(asset.status, Object.fromEntries(asset.headers)).end(Buffer.from(await asset.arrayBuffer()))
  }
  const servers = [createSecureServer({ ...tls, allowHTTP1: true }, serve), createSecureServer({ ...tls, allowHTTP1: true }, serve)]
  const sockets = new Set<Socket>()
  for (const server of servers) {
    server.on("secureConnection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
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
  await listenOnIpv6Loopback(servers[1], input.port)
  deployment = await readPublishedDeployment(input.hosted.workerUrl, (url) => hostedFetch(input.hosted, new URL(url).pathname))
  const spki = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })
  return {
    url: input.hosted.workerUrl,
    controlPlaneRequests: () => [...forwarded],
    trust: { caPath: input.hosted.certificate, spki: createHash("sha256").update(spki).digest("base64") },
    close: async () => {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy() })))
    },
  }
}
