import { describe, expect, test, vi } from "vitest"
import {
  admittedRepoUrl,
  cloudflareWorkerBaseUrl,
  publicRepoHost,
  repoUrlHost,
  safeRepoUrl,
  sandboxDriverAuthValues,
  dockerSandboxDriverEnabled,
  isSandboxDriverID,
  sandboxDriverCredentialFields,
  sandboxDriverIds,
} from "./index"

describe("sandbox contract", () => {
  test.each(["http://worker.test", "http://127.0.0.1:8787", "https://user:secret@worker.test", "https://worker.test/?x=1", "https://worker.test/#fragment", "not a URL"])("rejects insecure Worker configuration %s", (url) => {
    expect(() => cloudflareWorkerBaseUrl(url)).toThrow(/HTTPS/)
    expect(() => sandboxDriverAuthValues(undefined, "cloudflare", { CLOUDFLARE_API_TOKEN: "synthetic", CLOUDFLARE_SANDBOX_WORKER_URL: url })).toThrow(/HTTPS/)
  })

  test("canonical Worker URL retains its HTTPS path prefix", () => {
    expect(cloudflareWorkerBaseUrl(" https://worker.test/prefix/// ")).toBe("https://worker.test/prefix")
  })
  test("owns one credential schema for every driver identity", () => {
    expect(sandboxDriverIds).toEqual(["exe", "daytona", "modal", "vercel", "cloudflare", "box", "docker"])
    expect(Object.keys(sandboxDriverCredentialFields).sort()).toEqual([...sandboxDriverIds].sort())
    expect(sandboxDriverCredentialFields.modal.map((field) => field.key)).toEqual(["token_id", "token_secret"])
  })

  test("recognizes only canonical driver identities", () => {
    expect(isSandboxDriverID("daytona")).toBe(true)
    expect(isSandboxDriverID("fetch")).toBe(false)
    expect(isSandboxDriverID(undefined)).toBe(false)
  })

  test("keeps local Docker activation explicit", () => {
    expect(dockerSandboxDriverEnabled({})).toBe(false)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_ENABLE_DOCKER_SANDBOX: "true" })).toBe(true)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_DEV_DOCKER_SANDBOX: "1" })).toBe(true)
  })

  test.each([
    "https://github.com/acme/repo.git",
    "http://git.internal/acme/repo.git",
    "ssh://git@github.com/acme/repo.git",
    "git@github.com:acme/repo.git",
  ])("admits cloneable repository URL %s", (url) => {
    expect(safeRepoUrl(url)).toBe(url)
  })

  test.each([
    "file:///etc/passwd",
    "ftp://example.com/repo.git",
    "ext::sh -c whoami",
    "not a url",
    "--upload-pack=touch /tmp/pwn",
  ])("refuses %s before it can reach a clone", (url) => {
    expect(safeRepoUrl(url)).toBeUndefined()
  })
})

describe("repository destination admission", () => {
  test("repoUrlHost reads the dial host of every admitted form", () => {
    expect(repoUrlHost("https://github.com/acme/repo.git")).toBe("github.com")
    expect(repoUrlHost("ssh://git@gitlab.com:2222/acme/repo.git")).toBe("gitlab.com")
    expect(repoUrlHost("git@github.com:acme/repo.git")).toBe("github.com")
    expect(repoUrlHost("HTTPS://GITHUB.COM/acme/repo.git")).toBe("github.com")
    expect(repoUrlHost("file:///etc/passwd")).toBeUndefined()
    expect(repoUrlHost("not a url")).toBeUndefined()
  })

  test.each([
    "http://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/acme/repo.git",
    "git@192.168.1.10:acme/repo.git",
    "ssh://git@[::1]/acme/repo.git",
    "http://localhost:8080/acme/repo.git",
    "https://git.localhost/acme/repo.git",
    // Every spelling lands on the same classification: 127.0.0.1 written
    // shorthand, hex, or mapped into IPv6.
    "http://127.1/acme/repo.git",
    "http://0x7f000001/acme/repo.git",
    "http://[::ffff:7f00:1]/acme/repo.git",
    "http://[::ffff:a00:1]/acme/repo.git",
  ])("publicRepoHost refuses the non-public destination %s", (url) => {
    expect(publicRepoHost(url)).toBeUndefined()
  })

  test("publicRepoHost keeps public literals and hands DNS names through", () => {
    expect(publicRepoHost("https://github.com/acme/repo.git")).toBe("github.com")
    expect(publicRepoHost("git@github.com:acme/repo.git")).toBe("github.com")
    expect(publicRepoHost("https://140.82.112.3/acme/repo.git")).toBe("140.82.112.3")
  })

  test("a named host is refused when nothing can resolve it, or it resolves nowhere", async () => {
    await expect(admittedRepoUrl("https://git.acme.test/repo.git")).resolves.toBeUndefined()
    await expect(
      admittedRepoUrl("https://git.acme.test/repo.git", { resolve: async () => [] }),
    ).resolves.toBeUndefined()
  })

  test("a single private answer refuses the whole destination", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34", "10.0.0.5"] as const)
    await expect(
      admittedRepoUrl("https://git.acme.test/repo.git", { resolve }),
    ).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledWith("git.acme.test")
  })

  test("an all-public answer admits, and literals never reach the resolver", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34"] as const)
    await expect(
      admittedRepoUrl("https://git.acme.test/repo.git", { resolve }),
    ).resolves.toBe("https://git.acme.test/repo.git")
    await expect(
      admittedRepoUrl("http://169.254.169.254/latest", { resolve }),
    ).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalledWith("169.254.169.254")
  })

  test("loopback is admitted only under the explicit exemption", async () => {
    for (const url of ["http://127.0.0.1:8080/repo.git", "http://localhost:8080/repo.git", "ssh://git@[::1]/repo.git"]) {
      await expect(admittedRepoUrl(url)).resolves.toBeUndefined()
      await expect(admittedRepoUrl(url, { loopback: true })).resolves.toBe(url)
    }
    // Loopback stays refused for a NAME that resolves to it, too — the
    // exemption covers the spelling, not just the literal.
    await expect(
      admittedRepoUrl("https://git.acme.test/repo.git", { loopback: true, resolve: async () => ["127.0.0.1"] }),
    ).resolves.toBe("https://git.acme.test/repo.git")
    await expect(
      admittedRepoUrl("https://git.acme.test/repo.git", { resolve: async () => ["127.0.0.1"] }),
    ).resolves.toBeUndefined()
  })

  test("operator-approved private hosts are admitted without resolving", async () => {
    const resolve = vi.fn(async () => [] as const)
    await expect(
      admittedRepoUrl("https://git.corp.internal/repo.git", { privateHosts: ["git.corp.internal"], resolve }),
    ).resolves.toBe("https://git.corp.internal/repo.git")
    await expect(
      admittedRepoUrl("http://169.254.169.254/x", { privateHosts: ["169.254.169.254"], resolve }),
    ).resolves.toBe("http://169.254.169.254/x")
    expect(resolve).not.toHaveBeenCalled()
    // Approval is exact: a sibling host is not covered.
    await expect(
      admittedRepoUrl("https://other.corp.internal/repo.git", { privateHosts: ["git.corp.internal"], resolve }),
    ).resolves.toBeUndefined()
  })
})
