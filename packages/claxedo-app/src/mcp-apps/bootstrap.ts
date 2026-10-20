export const MCP_APP_DOCUMENT_MESSAGE = "claxedo:mcp-app-document"

export const MCP_APP_BOOTSTRAP = `(() => {
  const JAVASCRIPT_TYPES = ["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]
  const blobUrls = []
  const kindOf = (script) => {
    const type = (script.getAttribute("type") || "").trim().toLowerCase()
    if (script.hasAttribute("nomodule")) return "data"
    if (type === "module") return script.hasAttribute("async") ? "async" : "deferred"
    if (!JAVASCRIPT_TYPES.includes(type)) return "data"
    if (!script.hasAttribute("src")) return "blocking"
    if (script.hasAttribute("async")) return "async"
    return script.hasAttribute("defer") ? "deferred" : "blocking"
  }
  const sourceOf = (script) => {
    if (script.hasAttribute("src")) return script.getAttribute("src")
    const url = URL.createObjectURL(new Blob([script.textContent || ""], { type: "text/javascript" }))
    blobUrls.push(url)
    return url
  }
  const run = (entry) => new Promise((resolve) => {
    const script = document.createElement("script")
    for (const attribute of Array.from(entry.original.attributes)) {
      if (attribute.name !== "src") script.setAttribute(attribute.name, attribute.value)
    }
    if (entry.kind !== "async" && script.getAttribute("type") !== "module") script.async = false
    script.addEventListener("load", () => resolve(), { once: true })
    script.addEventListener("error", () => resolve(), { once: true })
    script.src = sourceOf(entry.original)
    entry.placeholder.replaceWith(script)
  })
  const adopt = (html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html")
    const entries = Array.from(parsed.querySelectorAll("script")).map((original) => {
      const placeholder = parsed.createComment("")
      original.replaceWith(placeholder)
      return { original, placeholder, kind: kindOf(original) }
    })
    for (const attribute of Array.from(parsed.documentElement.attributes)) document.documentElement.setAttribute(attribute.name, attribute.value)
    for (const attribute of Array.from(parsed.body.attributes)) document.body.setAttribute(attribute.name, attribute.value)
    document.head.append(...Array.from(parsed.head.childNodes))
    document.body.append(...Array.from(parsed.body.childNodes))
    return entries
  }
  const start = async (html) => {
    const entries = adopt(html)
    for (const entry of entries.filter((item) => item.kind === "data")) entry.placeholder.replaceWith(entry.original)
    const started = entries.filter((item) => item.kind === "async").map(run)
    for (const entry of entries.filter((item) => item.kind === "blocking")) await run(entry)
    for (const entry of entries.filter((item) => item.kind === "deferred")) await run(entry)
    document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }))
    await Promise.all(started)
    window.dispatchEvent(new Event("load"))
    for (const url of blobUrls) URL.revokeObjectURL(url)
  }
  const receive = (event) => {
    const data = event.data
    if (event.source !== parent || !data || data.type !== "${MCP_APP_DOCUMENT_MESSAGE}" || typeof data.html !== "string") return
    removeEventListener("message", receive)
    start(data.html).catch((error) => console.error("The app document did not start", error))
  }
  addEventListener("message", receive)
})()`

export const MCP_APP_BOOTSTRAP_HASH = "sha256-ZzQVg+Z+Jugpu/+3tiGZAYrmn9+WJbWu2T0iyq2OUYM="
