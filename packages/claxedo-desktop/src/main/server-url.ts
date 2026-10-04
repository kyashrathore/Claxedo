/**
 * What the renderer may persist as the server to connect to next launch.
 *
 * Main dials this value before any window exists (`setupServerConnection`),
 * so it is the one renderer-written setting that decides where the app's
 * first request goes. An origin is the whole of what that dial needs: the
 * health probe and every later request build their own paths, and a userinfo
 * part would be sent as credentials to whatever host follows it.
 */
export type ServerUrlVerdict = { allowed: true; url: string | null } | { allowed: false; reason: string }

export function persistedServerUrlVerdict(input: unknown): ServerUrlVerdict {
  if (input === null) return { allowed: true, url: null }
  if (typeof input !== "string" || input === "") return { allowed: false, reason: "server url must be a string or null" }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { allowed: false, reason: "server url is not a URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `server url scheme ${url.protocol} is not http or https` }
  }
  if (url.username !== "" || url.password !== "") return { allowed: false, reason: "server url carries credentials" }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { allowed: false, reason: "server url must be an origin without a path" }
  }
  return { allowed: true, url: input }
}
