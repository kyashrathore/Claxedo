export const SURFACE_IMAGE_MAX_DATA_URL_LENGTH = 2_796_300

export type SurfaceImageRefusal = "scheme" | "mime" | "size" | "origin"

export type SurfaceImageUrl = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: SurfaceImageRefusal }

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

function blobOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

export function surfaceImageUrl(value: string, origin?: string): SurfaceImageUrl {
  const scheme = value.slice(0, value.indexOf(":") + 1).toLowerCase()
  if (scheme === "data:") {
    if (value.length > SURFACE_IMAGE_MAX_DATA_URL_LENGTH) return { ok: false, reason: "size" }
    return IMAGE_DATA_URL.test(value) ? { ok: true, url: value } : { ok: false, reason: "mime" }
  }
  if (scheme === "blob:") {
    const own = blobOrigin(value)
    return origin !== undefined && origin !== "null" && own === origin ? { ok: true, url: value } : { ok: false, reason: "origin" }
  }
  return { ok: false, reason: "scheme" }
}

export const SURFACE_IMAGE_REFUSALS: Readonly<Record<SurfaceImageRefusal, string>> = {
  scheme: "an Image url is a data: URL of a PNG, JPEG, GIF or WebP, or a blob: URL of the app's own origin",
  mime: "an Image data: URL is base64 PNG, JPEG, GIF or WebP (no SVG)",
  size: `an Image data: URL is at most ${SURFACE_IMAGE_MAX_DATA_URL_LENGTH} characters (2 MiB decoded)`,
  origin: "an Image blob: URL must come from the app's own origin, so a spec can only bind one",
}
