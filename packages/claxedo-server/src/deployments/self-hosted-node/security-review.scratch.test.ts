import { test, expect } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

test("security review: new account accesses files and other user's worktree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-security-review-"))
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
  process.env.CLAXEDO_EMBEDDED_AUTH = "1"
  process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
  process.env.BETTER_AUTH_URL = "http://selfhost.test"
  process.env.CLAXEDO_CHANNELS_ENABLED = "0"
  const { createSelfHostedApp, createDefaultLocalControlPlaneServices } = await import("./app")
  const { resetEmbeddedAuthForTests } = await import("./embedded-auth")
  const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
  const services = createDefaultLocalControlPlaneServices()
  const { app } = createSelfHostedApp(services)
  try {
    const privateDir = path.join(root, "unregistered-private")
    await fs.mkdir(privateDir)
    await fs.writeFile(path.join(privateDir, "secret.txt"), "AUDIT_SYNTHETIC_SECRET")
    const fileUrl = `http://selfhost.test/file/content?directory=${encodeURIComponent(privateDir)}&path=secret.txt`
    const anonymous = await app.request(fileUrl)
    expect(anonymous.status).toBe(401)
    const signup = await app.request("http://selfhost.test/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "outsider@example.test", password: "audit-password-12345", name: "Outsider" }),
    })
    expect(signup.status).toBe(200)
    const token = signup.headers.get("set-auth-token")!
    expect(token).toBeTruthy()
    const headers = { authorization: `Bearer ${token}` }
    const leaked = await app.request(fileUrl, { headers })
    expect(leaked.status).toBe(200)
    expect(await leaked.json()).toMatchObject({ content: "AUDIT_SYNTHETIC_SECRET" })
    console.log("CONFIRMED: signup=200, anonymous file=401, outsider unregistered file=200 with synthetic secret")

    const repo = path.join(root, "owner-repo")
    await fs.mkdir(repo)
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" })
    git(["init", "-b", "main"])
    git(["config", "user.email", "audit@example.test"])
    git(["config", "user.name", "Audit"])
    await fs.writeFile(path.join(repo, "README.md"), "synthetic repo")
    git(["add", "README.md"])
    git(["commit", "-m", "audit fixture"])
    await ensureWorkspace({ workspaceId: "ws_audit_owner", project_id: "project_audit_owner", org_id: "org_owner", directory: repo })
    const child = path.join(repo, "private-child")
    await fs.mkdir(child)
    await fs.writeFile(path.join(child, "sentinel.txt"), "synthetic owner data")
    const response = await app.request(`http://selfhost.test/experimental/worktree?workspaceId=ws_audit_owner&directory=${encodeURIComponent(child)}`, { method: "DELETE", headers })
    expect(response.status).toBe(200)
    expect(await fs.stat(child).then(() => true, () => false)).toBe(false)
    console.log("CONFIRMED: outsider DELETE worktree=200, synthetic owner directory removed")
  } finally {
    services.close()
    resetEmbeddedAuthForTests()
    await fs.rm(root, { recursive: true, force: true })
  }
})
