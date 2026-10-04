import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { hostedFetch, inviteHostedPerson, signInHostedPerson } from "./hosted-auth"
import { startHostedStack } from "./hosted-stack"

test.skipIf(process.platform !== "darwin")("certified hosted Worker signs in two GitHub people and refuses unbrokered repository egress", async () => {
  const stack = await startHostedStack("auth-and-repository")
  try {
    const health = await hostedFetch(stack, "/health")
    expect(health.status).toBe(200)
    expect((await health.json() as { status: string }).status).toBe("ok")

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

    const invitationToken = await inviteHostedPerson(stack, owner, second, "hosted-e2e-organization")
    const accepted = await hostedFetch(stack, "/api/control/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: invitationToken }) }, second)
    expect(accepted.status).toBe(200)

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

    const created = await hostedFetch(stack, "/api/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Hosted Git", repoUrl: stack.gitUrl }),
    }, owner)
    expect(created.status).toBe(200)
    const workspace = await created.json() as { workspaceId: string }
    let connected: { runtimeAccessToken?: string; status?: string } | undefined
    const startedConnection = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(workspace.workspaceId)}/connection`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, owner)
    if (startedConnection.status !== 200 && startedConnection.status !== 409) {
      throw new Error(`hosted connect start failed: ${startedConnection.status} ${await startedConnection.text()}`)
    }
    const targetFile = path.join(stack.root, "local-broker-targets", `${workspace.workspaceId}.json`)
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await fs.access(targetFile)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await fs.access(targetFile)
    for (let attempt = 0; attempt < 5; attempt++) {
      const connection = await hostedFetch(stack, `/api/workspace/${encodeURIComponent(workspace.workspaceId)}/connection`, {}, owner)
      if (connection.status === 200) {
        connected = await connection.json() as typeof connected
        if (connected?.runtimeAccessToken) break
      } else {
        const failure = await connection.json() as { error?: { code?: string } }
        if (connection.status !== 409 || failure.error?.code !== "cloud_runtime_unavailable") {
          throw new Error(`hosted connect failed: ${connection.status} ${JSON.stringify(failure)}`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (!connected?.runtimeAccessToken) throw new Error(`hosted runtime never connected: ${JSON.stringify(connected)}`)
    const runtimeHealth = await fetch(`${stack.relayUrl}/workspaces/${encodeURIComponent(workspace.workspaceId)}/api/wr/health`, {
      headers: { authorization: `Bearer ${connected.runtimeAccessToken}` },
    })
    if (runtimeHealth.status !== 200) throw new Error(`hosted relay health failed: ${runtimeHealth.status} ${await runtimeHealth.text()}`)

    const attempts = await stack.outboundAttempts()
    expect(attempts.map((attempt) => attempt.url).sort()).toEqual([
      "https://1.1.1.1/dns-query?name=git.hosted.test&type=A",
      "https://1.1.1.1/dns-query?name=git.hosted.test&type=AAAA",
    ])
  } finally {
    await stack.close()
  }
}, 120_000)
