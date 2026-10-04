import { createHash } from "node:crypto"
import path from "node:path"
import type { HtmlTagDescriptor, Plugin } from "vite"
import { browserPreviewPolicy, contentSecurityPolicy } from "./content-security-policy"
import { FRAME_BOOTSTRAP } from "./src/plugins/frame/document"

export const WEB_CONTENT_SECURITY_POLICY_PLUGIN = "claxedo:web-content-security-policy"

function relayOrigins(): string[] {
  return (process.env.CLAXEDO_RELAY_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)
}

export function webContentSecurityPolicy(serverUrl: string | undefined): string {
  const server = serverUrl?.trim() || undefined
  return contentSecurityPolicy({
    servers: [...(server ? [server] : []), ...relayOrigins()],
    scripts: [`'sha256-${createHash("sha256").update(FRAME_BOOTSTRAP).digest("base64")}'`],
    frames: "self",
  })
}

function documentTags(policy: string): HtmlTagDescriptor[] {
  return [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    { tag: "meta", attrs: { "http-equiv": "x-dns-prefetch-control", content: "off" }, injectTo: "head-prepend" },
  ]
}

export function webContentSecurityPolicyPlugin(serverUrl: string | undefined): Plugin {
  const policies: Readonly<Record<string, string>> = {
    "index.html": webContentSecurityPolicy(serverUrl),
    "browser-preview.html": browserPreviewPolicy(),
  }
  return {
    name: WEB_CONTENT_SECURITY_POLICY_PLUGIN,
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (_html, context) => {
        const policy = policies[path.basename(context.filename)]
        if (!policy) throw new Error(`${context.filename} has no Content-Security-Policy; name one in vite.content-security-policy.ts`)
        return documentTags(policy)
      },
    },
  }
}
