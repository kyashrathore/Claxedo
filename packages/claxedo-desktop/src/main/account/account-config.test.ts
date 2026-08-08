import { describe, expect, test } from "bun:test"
import { readAccountConfig } from "./account-config"

/**
 * Reading the OAuth client configuration.
 *
 * `index.ts` itself imports electron and cannot be loaded here; this is the one
 * decision in it worth testing, and it is exported for exactly that reason.
 */

const COMPLETE = {
  CLAXEDO_ACCOUNT_AUTHORIZE_URL: "https://accounts.example.com/authorize",
  CLAXEDO_ACCOUNT_TOKEN_URL: "https://accounts.example.com/token",
  CLAXEDO_ACCOUNT_CLIENT_ID: "client_desktop",
  CLAXEDO_SERVER_ORIGIN: "https://control.example.com",
}

describe("readAccountConfig", () => {
  test("reads a complete configuration", () => {
    expect(readAccountConfig(COMPLETE)).toMatchObject({
      configured: true,
      clientId: "client_desktop",
      scope: "openid profile email",
    })
  })

  test("names exactly what is missing", () => {
    // This is the error a release owner sees when a build ships without its
    // client registered. "Sign-in is unavailable" with no detail is a support
    // thread; a list of variable names is a fix.
    const result = readAccountConfig({ CLAXEDO_ACCOUNT_CLIENT_ID: "c" })

    expect(result).toEqual({ configured: false, missing: ["authorizeUrl", "tokenUrl", "serverOrigin"] })
  })

  test("treats blank and whitespace as absent", () => {
    // A shipped `.env` with `CLAXEDO_ACCOUNT_CLIENT_ID=` present but empty
    // would otherwise read as configured and fail at the authorize call.
    expect(readAccountConfig({ ...COMPLETE, CLAXEDO_ACCOUNT_CLIENT_ID: "   " })).toMatchObject({
      configured: false,
      missing: ["clientId"],
    })
  })

  test("keeps an explicit scope", () => {
    expect(readAccountConfig({ ...COMPLETE, CLAXEDO_ACCOUNT_SCOPE: "openid" })).toMatchObject({ scope: "openid" })
  })
})
