import { describe, expect, test } from "vitest"
import {
  cloudflareWorkerBaseUrl,
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
