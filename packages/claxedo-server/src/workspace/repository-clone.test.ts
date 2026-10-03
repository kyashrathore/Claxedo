import { describe, expect, test } from "vitest"
import { githubCloneSecret } from "./repository-clone"

describe("GitHub clone credential", () => {
  test("brokers the connection token on that repository's smart-HTTP routes alone", () => {
    expect(githubCloneSecret("https://github.com/acme/private-repo.git", "github-secret:/@")).toEqual({
      name: "CLAXEDO_GITHUB_CLONE_AUTH",
      value: `Basic ${Buffer.from("x-access-token:github-secret:/@").toString("base64")}`,
      hosts: ["github.com"],
      header: "Authorization",
      methods: ["GET", "POST"],
      pathPrefixes: ["/acme/private-repo.git/"],
    })
  })

  test("refuses another host, another transport, a credential in the URL, or a path that is not one repository", () => {
    for (const url of [
      "https://gitlab.com/acme/app.git",
      "http://github.com/acme/app.git",
      "https://user@github.com/acme/app.git",
      "https://github.com/acme/app.git?ref=x",
      "https://github.com/acme/app",
      "https://github.com/acme/app/extra.git",
    ]) expect(() => githubCloneSecret(url, "secret")).toThrow("github_repository_url_required")
    expect(() => githubCloneSecret("git@github.com:acme/app.git", "secret")).toThrow()
  })
})
