import { describe, expect, test } from "bun:test"
import { raiseD1Bookmark } from "./d1-bookmark"

const OLDER = "0000003e-00000005-00004f7c-3b4f1a3b4f1a3b4f1a3b4f1a3b4f1a3b"
const NEWER = "0000003e-00000006-00000001-00000000000000000000000000000000"

/** A cookie jar as `document.cookie` behaves: reading lists name=value pairs, assigning sets one cookie. */
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
      const [pair] = line.split("; ")
      const separator = pair.indexOf("=")
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    },
  }
}

describe("raiseD1Bookmark", () => {
  test("a notice's bookmark becomes the control-plane cookie the next requests carry", () => {
    const cookies = jar({ "__Secure-claxedo.session_token": "token" })
    raiseD1Bookmark({ type: "provision", workspaceId: "ws_1", step: "ready", d1Bookmark: NEWER }, cookies)
    expect(cookies.written).toEqual([`__Host-claxedo.d1-control=${NEWER}; Path=/; Max-Age=300; Secure; SameSite=Lax`])
    expect(cookies.cookie).toContain(`__Host-claxedo.d1-control=${NEWER}`)
  })

  test("a bookmark older than the one held is never written over it", () => {
    const cookies = jar({ "__Host-claxedo.d1-control": NEWER })
    raiseD1Bookmark({ type: "session.share.changed", d1Bookmark: OLDER }, cookies)
    raiseD1Bookmark({ type: "session.share.changed", d1Bookmark: NEWER }, cookies)
    expect(cookies.written).toEqual([])
  })

  test("a newer bookmark replaces an older one, and a frame without a bookmark changes nothing", () => {
    const cookies = jar({ "__Host-claxedo.d1-control": OLDER })
    raiseD1Bookmark({ type: "session.status.changed" }, cookies)
    raiseD1Bookmark({ type: "session.status.changed", d1Bookmark: "not-a-bookmark" }, cookies)
    raiseD1Bookmark("heartbeat", cookies)
    expect(cookies.written).toEqual([])
    raiseD1Bookmark({ type: "session.status.changed", d1Bookmark: NEWER }, cookies)
    expect(cookies.cookie).toBe(`__Host-claxedo.d1-control=${NEWER}`)
  })
})
