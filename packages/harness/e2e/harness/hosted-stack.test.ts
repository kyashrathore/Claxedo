import { expect, test } from "bun:test"
import { hostedFetch, signInHostedPerson } from "./hosted-auth"
import { startHostedStack } from "./hosted-stack"

test("certified hosted Worker signs in two GitHub people and refuses unbrokered repository egress", async () => {
  const stack = await startHostedStack("auth-and-repository")
  try {
    const health = await hostedFetch(stack, "/health")
    expect(health.status).toBe(200)
    expect((await health.json() as { status: string }).status).toBe("open")

    const owner = await signInHostedPerson(stack, "hosted-person-a")
    const second = await signInHostedPerson(stack, "hosted-person-b")
    expect(owner.id).not.toBe(second.id)

    const claim = await stack.provisionOwnerClaim(owner.id)
    const bootstrapped = await hostedFetch(stack, "/api/claxedo/auth/bootstrap-owner", {
      method: "POST",
      headers: { "content-type": "application/json", "x-claxedo-bootstrap-owner-claim": claim },
      body: "{}",
    }, owner)
    expect(bootstrapped.status).toBe(200)
    expect((await bootstrapped.json() as { organizations: Array<{ id: string; name: string }> }).organizations).toEqual([
      { id: "hosted-e2e-organization", name: "Hosted E2E" },
    ])

    const admitted = await hostedFetch(stack, "/api/control/user-deployed/identity-admissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: second.id, role: "member" }),
    }, owner)
    expect(admitted.status).toBe(200)

    for (const [repoUrl, code] of [
      [undefined, "cloud_workspace_source_required"],
      [`${stack.sandboxOrigin}/repo.git`, "repo_url_invalid"],
      ["https://git.hosted.test/repo.git", "repo_url_invalid"],
    ] as const) {
      const created = await hostedFetch(stack, "/api/workspace/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceName: "Hosted E2E", ...(repoUrl ? { repoUrl } : {}) }),
      }, owner)
      expect(created.status).toBe(400)
      expect((await created.json() as { error: { code: string } }).error.code).toBe(code)
    }

    const attempts = await stack.outboundAttempts()
    expect(attempts.map((attempt) => attempt.url).sort()).toEqual([
      "https://1.1.1.1/dns-query?name=git.hosted.test&type=A",
      "https://1.1.1.1/dns-query?name=git.hosted.test&type=AAAA",
    ])
  } finally {
    await stack.close()
  }
}, 120_000)
