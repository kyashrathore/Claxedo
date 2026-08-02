import { describe, expect, test } from "bun:test"
import { githubIntegration } from "./github.js"

describe("GitHub code-host repositories", () => {
  test("lists and paginates repositories with real read/write permissions", async () => {
    const calls: string[] = []
    const fetchImpl = async (input: string | URL | Request) => {
      calls.push(String(input))
      const page = new URL(String(input)).searchParams.get("page")
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

    const repositories = await integration.impl.listRepositories?.({}, "github-secret")
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

  test("fails without echoing provider response bodies", async () => {
    const integration = githubIntegration({
      fetchImpl: (async () => new Response("token github-secret denied", { status: 403 })),
    })
    await expect(integration.impl.listRepositories?.({}, "github-secret")).rejects.toThrow("github_repositories_unauthorized")
  })
})
