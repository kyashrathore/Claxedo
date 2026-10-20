import { carriesSessionCookie } from "../../src/platform/auth/session-cookie"
import { shellPreloadLinks } from "./shell-preloads"

/** The two documents the build publishes for a client route, by the path the assets serve them at. */
export type ShellDocument = {
  readonly path: "/index.html" | "/login.html"
  readonly link: string | undefined
}

/**
 * A signed-out visitor's first page is the sign-in form, so the app's
 * signed-out document, which loads the form and nothing of the app, answers
 * the two paths such a visitor arrives at: the home and `/login`, the path the
 * app itself sends a signed-out reader to. Every other client route keeps the
 * app shell, whose router draws the auth screens with their own pages
 * (`/invitations`, `/device`, `/oauth/consent`) and sends the rest to `/login`.
 */
const SIGNED_OUT_PATHS = new Set(["/", "/login"])

/**
 * Which document answers a client route, and the `Link` header it carries. The
 * cookie is the only sign the edge has of a signed-in browser: with it the
 * shell declares the boot reads as preloads, and a cookie that no longer names
 * a session preloads once for nothing, since the session read's answer clears
 * it. Without it the home and `/login` get the signed-out document, which
 * declares its one read in its own head, and any other route the shell as the
 * assets serve it.
 */
export function shellDocument(pathname: string, cookieHeader: string | null | undefined): ShellDocument {
  if (carriesSessionCookie(cookieHeader)) return { path: "/index.html", link: shellPreloadLinks() }
  if (SIGNED_OUT_PATHS.has(pathname)) return { path: "/login.html", link: undefined }
  return { path: "/index.html", link: undefined }
}
