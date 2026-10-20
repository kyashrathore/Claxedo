import { describe, expect, test } from "vitest"
import { shellDocument } from "./shell-document"
import { shellPreloadLinks } from "./shell-preloads"

const SESSION = "theme=dark; __Secure-claxedo.session_token=held"

describe("the document a client route gets", () => {
  test("a browser without the session cookie gets the signed-out document at the home and at /login, with no preloads", () => {
    for (const cookie of [null, undefined, "", "theme=dark", "__Secure-claxedo.session_token="]) {
      expect(shellDocument("/", cookie)).toEqual({ path: "/login.html", link: undefined })
      expect(shellDocument("/login", cookie)).toEqual({ path: "/login.html", link: undefined })
    }
  })

  test("a browser without the session cookie gets the shell as the assets serve it on every other route", () => {
    for (const pathname of ["/w/workspace-1/session/ses_1", "/s/ses_1", "/settings", "/welcome", "/invitations", "/device", "/oauth/consent", "/login/", "/index.html"]) {
      expect(shellDocument(pathname, null)).toEqual({ path: "/index.html", link: undefined })
    }
  })

  test("a browser carrying the session cookie gets the shell with the boot reads preloaded, on the home and /login too", () => {
    for (const pathname of ["/", "/login", "/w/workspace-1/session/ses_1"]) {
      expect(shellDocument(pathname, SESSION)).toEqual({ path: "/index.html", link: shellPreloadLinks() })
    }
  })
})
