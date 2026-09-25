import { expect, test } from "vitest"
import { admittedRepoUrl } from "@claxedo/sandbox-contract"
import { privateRepoHosts } from "./private-repo-hosts"

test("private Git admission is limited to the exact deployment host", async () => {
  const unset = privateRepoHosts({})
  expect(await admittedRepoUrl("http://localhost:47100/repo.git", { privateHosts: unset })).toBeUndefined()

  const named = privateRepoHosts({ CLAXEDO_PRIVATE_REPO_HOSTS: " localhost " })
  expect(named).toEqual(["localhost"])
  expect(await admittedRepoUrl("http://localhost:47100/repo.git", { privateHosts: named }))
    .toBe("http://localhost:47100/repo.git")
  expect(await admittedRepoUrl("http://127.0.0.1:47100/repo.git", { privateHosts: named })).toBeUndefined()
})
