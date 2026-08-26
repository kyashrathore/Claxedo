import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The renderer's `Principal` must never carry bearer material or a way to mint
 * it.
 *
 * It used to expose `getToken`, and nothing ever called it — the capability was
 * pure surface area: a handle to bearer material on an object every component
 * reading `usePrincipal()` holds. Unit 6 makes that structural rather than
 * incidental, because Electron main becomes the sole owner of the desktop
 * account session and hands the renderer sanitized state plus named operations.
 * A token accessor here would be a second, contradictory path to the same
 * material — and the kind that is invisible in review, since it reads like an
 * ordinary field.
 */

const APP_SRC = path.resolve(import.meta.dir, "..")

function read(rel: string) {
  return fs.readFileSync(path.join(APP_SRC, rel), "utf8")
}

/** The `Principal` union, isolated from the rest of the module. */
function principalUnion() {
  const source = read("platform/auth/identity-provider.tsx")
  const start = source.indexOf("export type Principal =")
  expect(start, "Principal must still be declared here").toBeGreaterThan(-1)
  const end = source.indexOf("\nexport ", start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

describe("Principal carries no credential", () => {
  test("declares no token, secret, or credential-bearing member", () => {
    const union = principalUnion()

    for (const banned of ["getToken", "token", "accessToken", "bearer", "credential", "secret", "jwt"]) {
      expect(union.toLowerCase(), `Principal must not name \`${banned}\``).not.toContain(banned.toLowerCase())
    }
  })

  test("declares only identity and role members", () => {
    // An allowlist rather than a denylist: a future field called something
    // innocuous that happens to carry a token would pass the check above.
    // Every `name:` / `name?:` in the union, wherever it sits — a single-line
    // member declares several on one line, and anchoring to line starts saw
    // only the first. Mutation-checked: adding `sessionHandle: string` beside
    // `userId` slipped past the anchored version.
    const members = [...principalUnion().matchAll(/([a-zA-Z][\w]*)\s*\??\s*:/g)].map((match) => match[1]!)
    const allowed = new Set(["kind", "deviceId", "userId", "orgId", "memberships", "workspaceId", "role"])

    expect(members.filter((member) => !allowed.has(member))).toEqual([])
  })

  test("the provider populates it from identity only", () => {
    // The type could stay clean while the provider spreads extra fields in.
    const provider = read("platform/auth/principal-provider.tsx")
    expect(provider).not.toContain("getToken")
  })
})
