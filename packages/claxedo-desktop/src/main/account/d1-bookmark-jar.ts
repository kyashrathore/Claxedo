import {
  D1_BOOKMARK_MAX_AGE_SECONDS,
  D1_BOOKMARKS_HEADER,
  isD1Bookmark,
  newerD1Bookmark,
  readD1Bookmarks,
  writeD1Bookmarks,
  type D1BookmarkName,
} from "@claxedo/agent-runtime-contract"

/**
 * The newest D1 bookmarks each hosted control plane has handed this app, on
 * its answers and on the live-sync notices of other actors' writes, echoed on
 * every later call so the plane answers the app's reads from a replica that
 * already holds them. The main process's fetch has no cookie jar to carry
 * them the way the browser's does. Each lapses as the browser's cookie does.
 */
export function d1BookmarkJar(now: () => number) {
  const origins = new Map<string, Map<D1BookmarkName, { bookmark: string; at: number }>>()
  const raise = (origin: string, name: D1BookmarkName, bookmark: string) => {
    let held = origins.get(origin)
    if (!held) origins.set(origin, (held = new Map()))
    const current = held.get(name)?.bookmark
    if (newerD1Bookmark(current, bookmark) === bookmark) held.set(name, { bookmark, at: now() })
  }
  return {
    header(origin: string): Record<string, string> {
      const live = [...(origins.get(origin) ?? [])].flatMap(([name, held]) =>
        now() - held.at < D1_BOOKMARK_MAX_AGE_SECONDS ? [[name, held.bookmark] as const] : [])
      return live.length > 0 ? { [D1_BOOKMARKS_HEADER]: writeD1Bookmarks(live) } : {}
    },
    fromResponse(origin: string, response: Response) {
      for (const [name, bookmark] of readD1Bookmarks(response.headers.get(D1_BOOKMARKS_HEADER) ?? "")) raise(origin, name, bookmark)
    },
    /** A reader of one event stream's text as it arrives, raising the control bookmark from each `data:` frame that names one. */
    eventStream(origin: string) {
      let partial = ""
      return (text: string) => {
        const lines = (partial + text).split("\n")
        partial = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const bookmark = announcedBookmark(line.slice("data:".length))
          if (bookmark) raise(origin, "control", bookmark)
        }
      }
    },
  }
}

function announcedBookmark(data: string) {
  try {
    const frame: unknown = JSON.parse(data)
    const bookmark = typeof frame === "object" && frame !== null ? Reflect.get(frame, "d1Bookmark") : undefined
    return isD1Bookmark(bookmark) ? bookmark : undefined
  } catch {
    return undefined
  }
}
