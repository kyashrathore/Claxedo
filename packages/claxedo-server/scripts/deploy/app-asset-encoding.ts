/**
 * Hashed assets the Workers publisher stores a Brotli copy of. Everything else
 * Vite writes under `/assets` is a font, image or sound that is already
 * compressed, except KaTeX's `.ttf` fallbacks listed after their woff2 sources.
 */
export const PRECOMPRESSED_ASSET = /\.(?:css|js|svg)$/

/** The Brotli copy's path beside its asset, e.g. `/assets/main-abc.js.br`. */
export const brotliSibling = (pathname: string) => `${pathname}.br`

/** Whether an `Accept-Encoding` value admits `br` (RFC 9110 §12.5.3): listed with a nonzero weight, or unlisted under a nonzero `*`. */
export function acceptsBrotli(acceptEncoding: string | undefined) {
  let wildcard = 0
  for (const entry of (acceptEncoding ?? "").split(",")) {
    const [coding = "", ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase())
    const quality = parameters.find((parameter) => parameter.startsWith("q="))
    const weight = quality === undefined ? 1 : Number(quality.slice(2))
    if (coding === "br") return weight > 0
    if (coding === "*") wildcard = weight
  }
  return wildcard > 0
}
