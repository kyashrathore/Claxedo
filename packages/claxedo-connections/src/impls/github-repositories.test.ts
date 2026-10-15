import { describe, expect, test } from "bun:test"
import { githubIntegration } from "./github.js"

describe("GitHub code-host repositories", () => {
  test("lists and paginates repositories with real read/write permissions", async () => {
    const calls: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      calls.push(url)
      const page = new URL(url).searchParams.get("page")
      if (page === "1") {
        return Response.json(Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `repo-${index + 1}`,
          full_name: `acme/repo-${index + 1}`,
          clone_url: `https://github.com/acme/repo-${index + 1}.git`,
          private: true,
          permissions: { pull: true, push: index === 0 },
        })))
      }
      return Response.json([{
        id: 101,
        name: "public-demo",
        full_name: "acme/public-demo",
        clone_url: "https://github.com/acme/public-demo.git",
        private: false,
        permissions: { pull: true, push: false },
      }])
    }
    const integration = githubIntegration({ fetchImpl: fetchImpl })

    const repositories = await integration.impl.actions["code-host"]!.listRepositories?.({}, "github-secret")
    expect(repositories).toHaveLength(101)
    expect(repositories?.[0]).toEqual({
      id: "1",
      name: "repo-1",
      fullName: "acme/repo-1",
      cloneUrl: "https://github.com/acme/repo-1.git",
      private: true,
      permissions: { read: true, write: true },
    })
    expect(repositories?.[100]?.permissions).toEqual({ read: true, write: false })
    expect(calls).toEqual([
      "https://api.github.com/user/repos?per_page=100&page=1&sort=updated",
      "https://api.github.com/user/repos?per_page=100&page=2&sort=updated",
    ])
    expect(JSON.stringify(repositories)).not.toContain("github-secret")
  })

  test("an app user token's installations say where the app is granted more repositories", async () => {
    const calls: string[] = []
    const integration = githubIntegration({
      fetchImpl: async (input: string | URL | Request) => {
        calls.push(input instanceof Request ? input.url : input.toString())
        return Response.json({ total_count: 2, installations: [
          { id: 7, account: { login: "acme" }, html_url: "https://github.com/organizations/acme/settings/installations/7", repository_selection: "selected" },
          { id: 8, account: { login: "octo" }, html_url: "https://github.com/settings/installations/8", repository_selection: "all" },
        ] })
      },
    })
    expect(await integration.impl.actions["code-host"]!.repositoryAccess?.({}, "ghu_secret")).toEqual({ kind: "app", installations: [
      { account: "acme", settingsUrl: "https://github.com/organizations/acme/settings/installations/7", repositorySelection: "selected" },
      { account: "octo", settingsUrl: "https://github.com/settings/installations/8", repositorySelection: "all" },
    ] })
    expect(calls).toEqual(["https://api.github.com/user/installations?per_page=100"])
  })

  test("an app installed nowhere the user reaches has no installation to grant from", async () => {
    const integration = githubIntegration({ fetchImpl: async () => Response.json({ total_count: 0, installations: [] }) })
    expect(await integration.impl.actions["code-host"]!.repositoryAccess?.({}, "ghu_secret")).toEqual({ kind: "app", installations: [] })
  })

  test("a personal access token, which GitHub refuses installations to, is granted repositories in its own settings", async () => {
    const integration = githubIntegration({ fetchImpl: async () => new Response("must authenticate with an app token", { status: 403 }) })
    expect(await integration.impl.actions["code-host"]!.repositoryAccess?.({}, "github_pat_secret")).toEqual({
      kind: "token",
      settingsUrl: "https://github.com/settings/personal-access-tokens",
    })
  })

  test("fails without echoing provider response bodies", async () => {
    const integration = githubIntegration({
      fetchImpl: (async () => new Response("token github-secret denied", { status: 403 })),
    })
    await expect(integration.impl.actions["code-host"]!.listRepositories?.({}, "github-secret")).rejects.toThrow("github_repositories_unauthorized")
    await expect(integration.impl.actions["code-host"]!.listRepositories?.({}, "github-secret")).rejects.toMatchObject({ code: "repository_provider_unauthorized", status: 502, retryable: false })
  })
})
