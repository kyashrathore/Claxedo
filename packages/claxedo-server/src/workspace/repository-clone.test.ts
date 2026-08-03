import { describe, expect, test } from "vitest"
import { authenticatedGitHubCloneSource } from "./repository-clone"

describe("authenticated GitHub clone URL", () => {
  test("brokers the connection token on GitHub egress while keeping the clone URL clean", () => {
    const clean = "https://github.com/acme/private-repo.git"
    const source = authenticatedGitHubCloneSource(clean, "github-secret:/@")
    expect(source.repoUrl).toBe(clean)
    expect(source.secret).toEqual({
      name: "CLAXEDO_GITHUB_CLONE_AUTH",
      value: `Basic ${Buffer.from("x-access-token:github-secret:/@").toString("base64")}`,
      hosts: ["github.com"],
      header: "Authorization",
    })
    expect(source.repoUrl).not.toContain("github-secret")
  })

  test("refuses non-GitHub and non-HTTPS repository URLs", () => {
    expect(() => authenticatedGitHubCloneSource("https://gitlab.com/acme/app.git", "secret")).toThrow("github_repository_url_required")
    expect(() => authenticatedGitHubCloneSource("git@github.com:acme/app.git", "secret")).toThrow("github_repository_url_required")
  })
})
