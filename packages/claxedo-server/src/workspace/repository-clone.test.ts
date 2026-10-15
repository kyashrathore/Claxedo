import { describe, expect, test, vi } from "vitest"
import { githubCloneBrokerEnv, githubCloneSecret, hostedRepositoryCloneDelivery } from "./repository-clone"

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

  test("without a provider edge, the sandbox holds the broker's placeholder and binding URL, never the token", () => {
    expect(githubCloneBrokerEnv({ baseUrl: "https://api.claxedo.test/bindings/b1", placeholder: "pass" })).toEqual({
      CLAXEDO_GITHUB_CLONE_AUTH: "Bearer pass",
      CLAXEDO_GITHUB_CLONE_BROKER_URL: "https://api.claxedo.test/bindings/b1",
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

const workspace = { workspaceId: "ws_private", ownerUserId: "alice", orgId: "org-1" }
const clone = { repoUrl: "https://github.com/acme/private.git", connectionId: "conn_org", token: "ghs_installation" }

function broker() {
  return {
    repositoryBinding: vi.fn(async (input: { lease: { epoch: number; hostId: string } }) => ({
      baseUrl: "https://api.claxedo.test/bindings/b1",
      placeholder: `pass-${input.lease.epoch}`,
      expiresAt: Date.now() + 3_600_000,
    })),
  }
}

describe("a cloud workspace's private repository delivery", () => {
  test("a driver with its own edge gets the connection's token as an edge secret and no lease env", async () => {
    const minting = broker()
    const delivered = await hostedRepositoryCloneDelivery({ clone: async () => clone, secretBrokering: async () => "native", broker: minting })(workspace)
    expect(delivered).toEqual({ secrets: [githubCloneSecret(clone.repoUrl, clone.token)] })
    expect(minting.repositoryBinding).not.toHaveBeenCalled()
  })

  test("a driver without one gets no secret, and a placeholder minted for the lease it boots that carries no token", async () => {
    const minting = broker()
    const read = vi.fn(async () => clone)
    const delivered = await hostedRepositoryCloneDelivery({ clone: read, secretBrokering: async () => "none", broker: minting })(workspace)
    expect(delivered.secrets).toEqual([])
    expect(read).not.toHaveBeenCalled()
    const env = await delivered.leaseEnv!({ epoch: 4, hostId: "boat-ws_private" })
    expect(env).toEqual({ CLAXEDO_GITHUB_CLONE_AUTH: "Bearer pass-4", CLAXEDO_GITHUB_CLONE_BROKER_URL: "https://api.claxedo.test/bindings/b1" })
    expect(minting.repositoryBinding).toHaveBeenCalledWith({ ...workspace, connectionId: "conn_org", lease: { epoch: 4, hostId: "boat-ws_private" } })
  })

  test("a repository anyone can clone boots with no lease env, and a plane with no broker delivers nothing", async () => {
    const minting = broker()
    const unbound = await hostedRepositoryCloneDelivery({ clone: async () => undefined, secretBrokering: async () => "none", broker: minting })(workspace)
    expect(await unbound.leaseEnv!({ epoch: 1, hostId: "boat-ws_private" })).toEqual({})
    expect(minting.repositoryBinding).not.toHaveBeenCalled()
    expect(await hostedRepositoryCloneDelivery({ clone: async () => clone, secretBrokering: async () => "none" })(workspace)).toEqual({ secrets: [] })
  })
})
