import { createHash } from "node:crypto"
import type { Plugin } from "vite"
import { contentSecurityPolicy, exactOrigin } from "./content-security-policy"
import { FRAME_BOOTSTRAP } from "./src/plugins/frame/document"

export const WEB_CONTENT_SECURITY_POLICY_PLUGIN = "claxedo:web-content-security-policy"

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"])
const LOOPBACK_PAGES = ["127.0.0.1", "localhost", "[::1]"].flatMap((host) => [`http://${host}:*`, `https://${host}:*`])
const LOOPBACK_CALLBACKS = ["127.0.0.1", "localhost", "[::1]"].map((host) => `http://${host}:*`)

function relayOrigins(): string[] {
  return (process.env.CLAXEDO_RELAY_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)
}

function servesLoopback(server: string | undefined): boolean {
  return server === undefined || LOOPBACK_HOSTS.has(new URL(exactOrigin(server)).hostname)
}

export function webContentSecurityPolicy(serverUrl: string | undefined): string {
  const server = serverUrl?.trim() || undefined
  return contentSecurityPolicy({
    servers: [...(server ? [server] : []), ...relayOrigins()],
    scripts: [`'sha256-${createHash("sha256").update(FRAME_BOOTSTRAP).digest("base64")}'`],
    frames: servesLoopback(server) ? LOOPBACK_PAGES : [],
    forms: LOOPBACK_CALLBACKS,
  })
}

export function webContentSecurityPolicyPlugin(serverUrl: string | undefined): Plugin {
  const content = webContentSecurityPolicy(serverUrl)
  return {
    name: WEB_CONTENT_SECURITY_POLICY_PLUGIN,
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content }, injectTo: "head-prepend" }],
    },
  }
}
