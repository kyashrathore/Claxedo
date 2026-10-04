import { FRAME_BOOT, FRAME_RUNTIME_GLOBAL } from "./protocol"

export const FRAME_BOOTSTRAP = `
const listen = (event) => {
  if (event.source !== parent || !event.data || event.data.type !== "${FRAME_BOOT}") return
  removeEventListener("message", listen)
  const boot = event.data
  const port = event.ports[0]
  const url = URL.createObjectURL(new Blob([boot.runtime], { type: "text/javascript" }))
  import(url).then(
    () => {
      URL.revokeObjectURL(url)
      globalThis.${FRAME_RUNTIME_GLOBAL}.start(port, boot)
    },
    (error) => port.postMessage({ type: "failed", reason: String((error && error.message) || error) }),
  )
}
addEventListener("message", listen)
`

function framePolicy(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    `font-src ${appOrigin} data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
}

export function frameDocument(appOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${framePolicy(appOrigin)}"><meta http-equiv="x-dns-prefetch-control" content="off"></head><body><script>${FRAME_BOOTSTRAP}</script></body></html>`
}
