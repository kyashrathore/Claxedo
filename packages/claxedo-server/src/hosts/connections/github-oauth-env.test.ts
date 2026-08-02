import { describe, expect, test } from "vitest"
import { githubIntegrationForEnv } from "./github-oauth"

describe("github oauth env", () => {
  test("a server with no app registered offers the pasted token only", () => {
    expect(githubIntegrationForEnv({}).decl.methods).toEqual(["key"])
  })

  test("a client id turns on the oauth method, keeping the key as fallback", () => {
    const decl = githubIntegrationForEnv({ GITHUB_CLIENT_ID: "Iv1.client" }).decl
    expect(decl.methods).toEqual(["oauth", "key"])
  })

  test("the client secret alone is not an app — oauth stays off", () => {
    // Without a client id there is nothing to start a device grant with, so
    // offering the button would be offering a dead end.
    expect(githubIntegrationForEnv({ GITHUB_CLIENT_SECRET: "shh" }).decl.methods).toEqual(["key"])
  })

  test("blank and whitespace env read as unset rather than as an empty client", () => {
    expect(githubIntegrationForEnv({ GITHUB_CLIENT_ID: "" }).decl.methods).toEqual(["key"])
    expect(githubIntegrationForEnv({ GITHUB_CLIENT_ID: "   " }).decl.methods).toEqual(["key"])
  })

  test("the claxedo-prefixed names win over the bare ones", () => {
    // A box that runs other GitHub tooling may already have GITHUB_CLIENT_ID
    // set for something else; the namespaced name is how a deployment says
    // which app is Claxedo's.
    const integration = githubIntegrationForEnv({
      GITHUB_CLIENT_ID: "bare",
      CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID: "namespaced",
    })
    expect(integration.decl.methods).toEqual(["oauth", "key"])
  })

  test("device flow works with no client secret configured", () => {
    // GitHub does not require the secret to refresh a device-minted token, so
    // a deployment that only ever uses device flow needs no secret at all.
    const integration = githubIntegrationForEnv({ GITHUB_CLIENT_ID: "Iv1.client" })
    expect(integration.impl.device).toBeDefined()
    expect(integration.impl.refresh).toBeDefined()
  })
})
