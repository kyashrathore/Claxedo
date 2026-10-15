import { describe, expect, test } from "vitest"
import { anonymousGitHubVisibility, githubRepositoryFullName } from "./repository-connection"

describe("anonymousGitHubVisibility", () => {
  const answering = (status: number) => {
    const asked: Array<{ url: string; authorization: string | null }> = []
    const visibility = anonymousGitHubVisibility(async (url, init) => {
      asked.push({ url, authorization: new Headers(init?.headers).get("authorization") })
      return new Response(status === 200 ? "001e# service=git-upload-pack\n" : null, { status })
    })
    return { visibility, asked }
  }

  test("asks GitHub's ref advertisement for the repository with no credential", async () => {
    const { visibility, asked } = answering(200)
    expect(await visibility("acme/widgets")).toBe("public")
    expect(asked).toEqual([{ url: "https://github.com/acme/widgets.git/info/refs?service=git-upload-pack", authorization: null }])
  })

  test("names a repository GitHub asks a credential for, or does not have, unreadable", async () => {
    for (const status of [401, 403, 404]) expect(await answering(status).visibility("acme/widgets")).toBe("unreadable")
  })

  test("fails on any other answer rather than guessing", async () => {
    await expect(answering(503).visibility("acme/widgets")).rejects.toThrow("GitHub answered 503")
  })
})

test("githubRepositoryFullName reads owner/repo from every form git clones github.com by, and nothing else", () => {
  for (const url of ["https://github.com/acme/widgets", "https://github.com/acme/widgets.git", "http://www.github.com/acme/widgets/", "git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets"]) {
    expect(githubRepositoryFullName(url)).toBe("acme/widgets")
  }
  for (const url of ["https://gitlab.com/acme/widgets", "https://github.com/acme", "https://github.com/acme/widgets/tree/main", "https://token@github.com/acme/widgets", "https://github.com/acme/widgets?x=1", "https://github.com/../widgets"]) {
    expect(githubRepositoryFullName(url)).toBeUndefined()
  }
})
