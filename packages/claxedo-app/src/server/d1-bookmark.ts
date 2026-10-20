import { D1_BOOKMARK_COOKIE_PREFIX, d1BookmarkCookie, isD1Bookmark, newerD1Bookmark } from "@claxedo/agent-runtime-contract"

const CONTROL = `${D1_BOOKMARK_COOKIE_PREFIX}control=`

function heldControlBookmark(cookies: string) {
  const held = cookies.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(CONTROL))?.slice(CONTROL.length)
  return isD1Bookmark(held) ? held : undefined
}

/**
 * Raises the control-plane bookmark the browser sends with every request to
 * the one a live-sync notice names, before the notice's re-reads go out, so
 * they are answered by a replica that already holds the change the notice
 * announces. The cookie jar is every tab's, so a newer bookmark is never
 * lowered.
 */
export function raiseD1Bookmark(frame: unknown, jar: { cookie: string }) {
  const announced = typeof frame === "object" && frame !== null ? Reflect.get(frame, "d1Bookmark") : undefined
  if (!isD1Bookmark(announced)) return
  const held = heldControlBookmark(jar.cookie)
  if (newerD1Bookmark(held, announced) === held) return
  jar.cookie = d1BookmarkCookie("control", announced)
}
