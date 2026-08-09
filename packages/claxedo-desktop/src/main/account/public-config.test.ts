import { describe, expect, test } from "bun:test"

import { accountConfigEnvironment } from "./public-config"

describe("accountConfigEnvironment", () => {
  const baked = {
    CLAXEDO_ACCOUNT_AUTHORIZE_URL: "https://identity.example/authorize",
    CLAXEDO_ACCOUNT_TOKEN_URL: "https://identity.example/token",
    CLAXEDO_ACCOUNT_CLIENT_ID: "desktop-public-client",
    CLAXEDO_ACCOUNT_SCOPE: "openid offline_access",
    CLAXEDO_SERVER_ORIGIN: "https://control.example",
  }

  test("uses baked public-client values on an end-user machine", () => {
    expect(accountConfigEnvironment({}, baked)).toEqual(baked)
  })

  test("lets a self-built app override public values at runtime", () => {
    expect(accountConfigEnvironment({
      CLAXEDO_ACCOUNT_AUTHORIZE_URL: "https://local.example/authorize",
      CLAXEDO_ACCOUNT_CLIENT_ID: "local-client",
    }, baked)).toMatchObject({
      CLAXEDO_ACCOUNT_AUTHORIZE_URL: "https://local.example/authorize",
      CLAXEDO_ACCOUNT_CLIENT_ID: "local-client",
      CLAXEDO_ACCOUNT_TOKEN_URL: baked.CLAXEDO_ACCOUNT_TOKEN_URL,
    })
  })

  test("does not let blank runtime values erase a baked registration", () => {
    expect(accountConfigEnvironment({ CLAXEDO_ACCOUNT_TOKEN_URL: "   " }, baked))
      .toMatchObject({ CLAXEDO_ACCOUNT_TOKEN_URL: baked.CLAXEDO_ACCOUNT_TOKEN_URL })
  })
})
