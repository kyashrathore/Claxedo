/**
 * How the hosted control plane's clients carry D1 bookmarks between requests.
 *
 * A bookmark names a version of one of the control plane's databases; a read
 * that starts from it is answered by a replica at least that new
 * (developers.cloudflare.com/d1/best-practices/read-replication/). The control
 * plane hands bookmarks out on its answers and on the live-sync notices of
 * the writes they announce; a client returns the newest it holds per
 * database, the browser as cookies and a client without a cookie jar in
 * `D1_BOOKMARKS_HEADER`, written as `auth=<bookmark>, control=<bookmark>`.
 */
export type D1BookmarkName = "auth" | "control"

export const D1_BOOKMARKS_HEADER = "x-claxedo-d1-bookmarks"

/** Followed by the database's name; `__Host-` keeps the cookie on the exact origin, over HTTPS, at path `/`. */
export const D1_BOOKMARK_COOKIE_PREFIX = "__Host-claxedo.d1-"

/**
 * Long enough to outlast replica lag, short enough that no bookmark outlives
 * the database it names: resetting staging recreates the control-plane
 * database, whose versions start again below any bookmark a client still holds.
 */
export const D1_BOOKMARK_MAX_AGE_SECONDS = 300

/** The cookie that carries `name`'s bookmark; scripts may read and raise it, since it says only which version a reader has seen. */
export function d1BookmarkCookie(name: D1BookmarkName, bookmark: string) {
  return `${D1_BOOKMARK_COOKIE_PREFIX}${name}=${bookmark}; Path=/; Max-Age=${D1_BOOKMARK_MAX_AGE_SECONDS}; Secure; SameSite=Lax`
}

const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/

export function isD1Bookmark(value: unknown): value is string {
  return typeof value === "string" && BOOKMARK.test(value)
}

/** D1 bookmarks "are lexicographically sortable", oldest first (developers.cloudflare.com/d1/reference/time-travel/). */
export function newerD1Bookmark(held: string | undefined, next: string): string {
  return held !== undefined && held >= next ? held : next
}

function isName(value: string): value is D1BookmarkName {
  return value === "auth" || value === "control"
}

export function readD1Bookmarks(header: string): [D1BookmarkName, string][] {
  return header.split(",").flatMap((entry) => {
    const separator = entry.indexOf("=")
    const name = entry.slice(0, separator).trim()
    const bookmark = entry.slice(separator + 1).trim()
    return separator > 0 && isName(name) && isD1Bookmark(bookmark) ? [[name, bookmark] as [D1BookmarkName, string]] : []
  })
}

export function writeD1Bookmarks(entries: Iterable<readonly [D1BookmarkName, string]>): string {
  return [...entries].map(([name, bookmark]) => `${name}=${bookmark}`).join(", ")
}

/** The bookmark a live-sync frame announces, past the write it rings for. */
export function announcedD1Bookmark(frame: unknown): string | undefined {
  const bookmark = typeof frame === "object" && frame !== null ? Reflect.get(frame, "d1Bookmark") : undefined
  return isD1Bookmark(bookmark) ? bookmark : undefined
}

const CONTROL_COOKIE = `${D1_BOOKMARK_COOKIE_PREFIX}control=`

/**
 * Raises the control-plane bookmark a browser's cookie jar (`document`)
 * sends with every request to `bookmark`, so the re-reads a notice sets off
 * are answered by a replica that holds the change it announces. The jar is
 * every tab's, so a newer bookmark is never lowered.
 */
export function raiseD1BookmarkCookie(jar: { cookie: string }, bookmark: string) {
  const held = jar.cookie.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(CONTROL_COOKIE))?.slice(CONTROL_COOKIE.length)
  if (isD1Bookmark(held) && held >= bookmark) return
  jar.cookie = d1BookmarkCookie("control", bookmark)
}
