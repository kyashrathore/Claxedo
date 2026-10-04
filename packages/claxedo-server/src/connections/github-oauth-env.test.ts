import { describe, expect, test } from "vitest"
import { githubIntegrationForEnv } from "./github-oauth"

describe("github oauth env", () => {
  test("a server with no app registered offers the pasted token only", () => {
    expect(githubIntegrationForEnv({}).decl.methods).toEqual(["key"])
  })

  test("the GitHub App's client id turns on the oauth method, keeping the key as fallback", () => {
    const decl = githubIntegrationForEnv({ CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: "Iv1.client" }).decl
    expect(decl.methods).toEqual(["oauth", "key"])
  })

  test("the sign-in OAuth app is never used for the integration's grant", () => {
    const integration = githubIntegrationForEnv({ GITHUB_CLIENT_ID: "sign-in-app", GITHUB_CLIENT_SECRET: "sign-in-secret" })
    expect(integration.decl.methods).toEqual(["key"])
    expect(integration.impl.auth?.device).toBeUndefined()
  })

  test("the client secret alone is not an app — oauth stays off", () => {
    expect(githubIntegrationForEnv({ CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET: "shh" }).decl.methods).toEqual(["key"])
  })

  test("blank and whitespace env read as unset rather than as an empty client", () => {
    expect(githubIntegrationForEnv({ CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: "" }).decl.methods).toEqual(["key"])
    expect(githubIntegrationForEnv({ CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: "   " }).decl.methods).toEqual(["key"])
  })

  test("device flow works with no client secret configured", () => {
    const integration = githubIntegrationForEnv({ CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: "Iv1.client" })
    expect(integration.impl.auth?.device).toBeDefined()
    expect(integration.impl.auth?.refresh).toBeDefined()
  })
})
