import { FRAME_BOOT, FRAME_RUNTIME_GLOBAL } from "./protocol"

const BOOTSTRAP = `
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

export const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${BOOTSTRAP}</script></body></html>`
