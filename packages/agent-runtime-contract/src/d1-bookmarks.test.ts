import { describe, expect, test } from "bun:test"
import { announcedD1Bookmark, raiseD1BookmarkCookie, readD1Bookmarks, writeD1Bookmarks } from "./d1-bookmarks"

const OLDER = "0000003e-00000005-00004f7c-3b4f1a3b4f1a3b4f1a3b4f1a3b4f1a3b"
const NEWER = "0000003e-00000006-00000001-00000000000000000000000000000000"

function jar(initial: Record<string, string> = {}) {
  const cookies = new Map(Object.entries(initial))
  const written: string[] = []
  return {
    written,
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    },
    set cookie(line: string) {
      written.push(line)
      const [pair = ""] = line.split("; ")
      const separator = pair.indexOf("=")
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    },
  }
}

describe("raiseD1BookmarkCookie", () => {
  test("a notice's bookmark becomes the control-plane cookie the next requests carry", () => {
    const cookies = jar({ "__Secure-claxedo.session_token": "token" })
    raiseD1BookmarkCookie(cookies, NEWER)
    expect(cookies.written).toEqual([`__Host-claxedo.d1-control=${NEWER}; Path=/; Max-Age=300; Secure; SameSite=Lax`])
    expect(cookies.cookie).toContain(`__Host-claxedo.d1-control=${NEWER}`)
  })

  test("a bookmark older than the one held is never written over it", () => {
    const cookies = jar({ "__Host-claxedo.d1-control": NEWER })
    raiseD1BookmarkCookie(cookies, OLDER)
    raiseD1BookmarkCookie(cookies, NEWER)
    expect(cookies.written).toEqual([])
  })

  test("a newer bookmark replaces an older one", () => {
    const cookies = jar({ "__Host-claxedo.d1-control": OLDER })
    raiseD1BookmarkCookie(cookies, NEWER)
    expect(cookies.cookie).toBe(`__Host-claxedo.d1-control=${NEWER}`)
  })
})

describe("the bookmark wire format", () => {
  test("a frame announces a bookmark only in its own field and only when it is one", () => {
    expect(announcedD1Bookmark({ type: "provision", d1Bookmark: NEWER })).toBe(NEWER)
    expect(announcedD1Bookmark({ type: "provision", d1Bookmark: "not-a-bookmark" })).toBeUndefined()
    expect(announcedD1Bookmark({ type: "provision" })).toBeUndefined()
    expect(announcedD1Bookmark("heartbeat")).toBeUndefined()
  })

  test("the header round-trips per database and drops what is not a bookmark of a known database", () => {
    expect(readD1Bookmarks(writeD1Bookmarks([["auth", OLDER], ["control", NEWER]]))).toEqual([["auth", OLDER], ["control", NEWER]])
    expect(readD1Bookmarks(`control=${NEWER}, other=${OLDER}, auth=garbage, =${OLDER}`)).toEqual([["control", NEWER]])
  })
})
