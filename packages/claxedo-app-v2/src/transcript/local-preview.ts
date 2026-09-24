/**
 * A loopback URL worth a "Local preview" row, or undefined.
 *
 * Bare output text only: a URL inside a quoted string is serialized
 * configuration (a JSON blob, an env value), not a dev-server announcement, and
 * a control-plane path is an endpoint to call, not an app to preview — process
 * listings leak both.
 */
export function localPreviewUrl(output: string): string | undefined {
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i.exec(output)
  if (!match) return undefined
  const quote = output[match.index - 1]
  if (quote === '"' || quote === "'") return undefined
  const url = match[0].replace(/0\.0\.0\.0/, "127.0.0.1").replace(/[.,)]+$/, "")
  try {
    if (new URL(url).pathname.startsWith("/api/")) return undefined
  } catch {
    return undefined
  }
  return url
}
