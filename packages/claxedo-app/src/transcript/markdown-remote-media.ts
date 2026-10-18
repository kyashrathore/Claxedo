const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"])

const MEDIA_ELEMENTS: ReadonlySet<string> = new Set(["img", "video", "audio"])

const FETCHING_ATTRIBUTES = ["src", "poster", "background"] as const

const CSS_RESOURCE = /\\|url\s*\(|image\s*\(|image-set\s*\(|cross-fade\s*\(/i

function isRemote(value: string, page: Location): boolean {
  if (!URL.canParse(value, page.href)) return false
  const url = new URL(value, page.href)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return url.origin !== page.origin && !LOOPBACK_HOSTS.has(url.hostname)
}

function linkInPlaceOf(media: Element, href: string) {
  const link = media.ownerDocument.createElement("a")
  link.setAttribute("href", href)
  link.textContent = media.getAttribute("alt") || media.getAttribute("title") || href
  media.replaceWith(link)
}

export function withholdRemoteFetches(node: Element, page: Location) {
  node.removeAttribute("srcset")
  const style = node.getAttribute("style")
  if (style && CSS_RESOURCE.test(style)) node.removeAttribute("style")
  for (const name of FETCHING_ATTRIBUTES) {
    const value = node.getAttribute(name)
    if (value === null || !isRemote(value, page)) continue
    if (name === "src" && MEDIA_ELEMENTS.has(node.localName)) {
      linkInPlaceOf(node, new URL(value, page.href).toString())
      return
    }
    node.removeAttribute(name)
  }
}
