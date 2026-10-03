import { readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { browserArtifactBuildId, prepareBrowserArtifactsForWorkers } from "./browser-app"
import { d1DatabaseIdByName, nativeClientVerificationSql, verifyNativeClientProvisioning } from "./d1-databases"
import {
  deployPlan,
  missingSecrets,
  parseDeployArguments,
  providedSecrets,
  verifyDeployedVersion,
  verifyServedBrowserBuild,
  workerSecretNames,
} from "./deploy-user-cloudflare"
import { fetchReleaseProbe } from "./release-probe"
import { userCloudflareDeployment, workerVariables } from "./user-cloudflare-config"
import { deployedVersionId, isAbsentWorkerFailure, isTransientWranglerFailure } from "./wrangler-cli"

const env = {
  CLAXEDO_API_ORIGIN: "https://api.example.com",
  CLAXEDO_APP_ORIGIN: "https://app.example.com",
  CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.com",
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "Acme",
  GITHUB_CLIENT_ID: "github-client",
} satisfies NodeJS.ProcessEnv

const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const instant = { attempts: 3, wait: async () => {} }

function responses(bodies: unknown[]) {
  const queue = [...bodies]
  return async () => Response.json(queue.length > 1 ? queue.shift() : queue[0])
}

describe("deploy-user-cloudflare", () => {
  test("accepts only --dry-run and --agent-plugins", () => {
    expect(parseDeployArguments([])).toEqual({ dryRun: false, agentPlugins: false })
    expect(parseDeployArguments(["--dry-run", "--agent-plugins"])).toEqual({ dryRun: true, agentPlugins: true })
    expect(() => parseDeployArguments(["--staging"])).toThrow(/unknown argument --staging/)
  })

  test("uploads the secrets the environment carries and refuses to publish while any required one is nowhere", () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: false })
    const provided = providedSecrets(deployment, {
      ...env,
      BETTER_AUTH_SECRET: "a".repeat(32),
      CLAXEDO_AUTH_INTROSPECTION_SECRET: "b".repeat(32),
      GITHUB_CLIENT_SECRET: "  ",
      UNRELATED_SECRET: "never uploaded",
    })
    expect(Object.keys(provided)).toEqual(["BETTER_AUTH_SECRET", "CLAXEDO_AUTH_INTROSPECTION_SECRET"])
    expect(missingSecrets(deployment, provided, [])).toEqual([
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
      "CLAXEDO_RELAY_HOST_VERIFY_PEM",
      "GITHUB_CLIENT_SECRET",
    ])
    const onWorker = workerSecretNames(
      JSON.stringify(
        deployment.requiredSecrets.slice(2).map((name) => ({ name, type: "secret_text" })),
      ),
    )
    expect(missingSecrets(deployment, provided, onWorker)).toEqual([])
  })

  test("uploads the GitHub App's client secret when the environment carries it, and never requires it", () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: false })
    const withApp = providedSecrets(deployment, { ...env, CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET: "app-secret" })
    expect(Object.keys(withApp)).toEqual(["CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET"])
    expect(missingSecrets(deployment, {}, deployment.requiredSecrets)).toEqual([])
  })

  test("prints a plan that names every resource and variable and no secret value", () => {
    const deployment = userCloudflareDeployment(env, { agentPlugins: false })
    const plan = deployPlan(deployment, workerVariables(deployment, "sha256:config"), {
      BETTER_AUTH_SECRET: "super-secret-value-that-must-not-print",
    })
    expect(plan).toContain("Worker              claxedo (user-deployed-better-auth-d1)")
    expect(plan).toContain("custom domain api.example.com")
    expect(plan).toContain("AUTH_DB=claxedo-auth  CONTROL_PLANE_DB=claxedo-control-plane  (created if missing)")
    expect(plan).toContain("https://api.example.com/api/auth/callback/github")
    expect(plan).toContain("  CLAXEDO_AUTH_CONFIGURATION_ID = sha256:config")
    expect(plan).toContain("Secrets uploaded    BETTER_AUTH_SECRET")
    expect(plan).not.toContain("super-secret-value-that-must-not-print")
  })

  test("reads the version wrangler deploy published for this Worker only", () => {
    const records = [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      JSON.stringify({ type: "deploy", version: 1, worker_name: "claxedo", version_id: VERSION }),
    ].join("\n")
    expect(deployedVersionId(records, "claxedo")).toBe(VERSION)
    expect(() => deployedVersionId(records, "claxedo-app")).toThrow(/exactly one version of claxedo-app/)
    expect(() => deployedVersionId(JSON.stringify({ type: "wrangler-session" }), "claxedo")).toThrow(/exactly one/)
  })

  test("waits for /health to name the new version, then for signed auth", async () => {
    await expect(
      verifyDeployedVersion("https://api.example.com", VERSION, {
        ...instant,
        fetcher: responses([{ status: "ok", platformVersionId: "previous" }, { status: "ok", platformVersionId: VERSION }, { signedAuth: true }]),
      }),
    ).resolves.toBeUndefined()
    await expect(
      verifyDeployedVersion("https://api.example.com", VERSION, {
        ...instant,
        fetcher: responses([{ status: "ok", platformVersionId: "previous" }]),
      }),
    ).rejects.toThrow(/did not converge after 3 attempts/)
    await expect(
      verifyDeployedVersion("https://api.example.com", VERSION, {
        ...instant,
        fetcher: responses([{ status: "ok", platformVersionId: VERSION }, { signedAuth: false }]),
      }),
    ).rejects.toThrow(/api\/claxedo\/mode did not converge/)
  })

  test("waits for the app domain to serve the build it just published", async () => {
    await expect(
      verifyServedBrowserBuild("https://app.example.com", "sha256:new", {
        ...instant,
        fetcher: responses([{ browserBuildId: "sha256:old" }, { browserBuildId: "sha256:new" }]),
      }),
    ).resolves.toBeUndefined()
  })

  test("retries a freshly attached domain through public DNS while keeping the HTTPS hostname", async () => {
    const observed: string[] = []
    const response = await fetchReleaseProbe(
      "https://api.example.com/health",
      {},
      {
        fetcher: async () => {
          throw new TypeError("cached NXDOMAIN")
        },
        resolver: async (hostname) => {
          expect(hostname).toBe("api.example.com")
          return ["192.0.2.10"]
        },
        addressFetcher: async (url, address) => {
          observed.push(`${url}@${address}`)
          return Response.json({ status: "ok" })
        },
      },
    )
    expect(response.status).toBe(200)
    expect(observed).toEqual(["https://api.example.com/health@192.0.2.10"])
  })

  test("classifies Wrangler failures it may retry or read as an absent Worker", () => {
    expect(isTransientWranglerFailure("fetch failed")).toBe(true)
    expect(isTransientWranglerFailure("Authentication error [code: 10000]")).toBe(false)
    expect(isAbsentWorkerFailure("This Worker does not exist on your account. [code: 10007]")).toBe(true)
    expect(isAbsentWorkerFailure("Authentication failed")).toBe(false)
  })
})

describe("D1 provisioning", () => {
  test("finds a database by exact name in wrangler d1 list output", () => {
    const list = JSON.stringify([
      { uuid: "11111111-1111-4111-8111-111111111111", name: "claxedo-auth" },
      { uuid: "22222222-2222-4222-8222-222222222222", name: "claxedo-auth-old" },
    ])
    expect(d1DatabaseIdByName(list, "claxedo-auth")).toBe("11111111-1111-4111-8111-111111111111")
    expect(d1DatabaseIdByName(list, "claxedo-control-plane")).toBeUndefined()
    expect(() => d1DatabaseIdByName(JSON.stringify({}), "claxedo-auth")).toThrow(/array of databases/)
  })

  test("verifies the three native OAuth clients and their resource links", () => {
    expect(nativeClientVerificationSql("https://api.example.com")).toContain("'https://api.example.com/control-plane'")
    const output = (row: Record<string, number>) => JSON.stringify([{ success: true, results: [row] }])
    expect(() => verifyNativeClientProvisioning(output({ clients: 3, resource: 1, links: 3 }))).not.toThrow()
    expect(() => verifyNativeClientProvisioning(output({ clients: 2, resource: 1, links: 2 }))).toThrow(/incomplete/)
  })

  test("keeps remote D1 trigger migrations compatible with Cloudflare's statement splitter", () => {
    for (const directory of ["auth", "control-plane"] as const) {
      const migrationDirectory = new URL(`../../migrations/${directory}/`, import.meta.url)
      for (const name of readdirSync(migrationDirectory).filter((candidate) => candidate.endsWith(".sql"))) {
        const bytes = readFileSync(new URL(name, migrationDirectory))
        expect(bytes.includes(13), `${directory}/${name} must use LF line endings`).toBe(false)
        const sql = bytes.toString("utf8")
        if (/create trigger/i.test(sql)) {
          expect(sql, `${directory}/${name} must spell trigger BEGIN in uppercase`).not.toMatch(/\bbegin\b/)
        }
      }
    }
  })
})

describe("browser app artifact", () => {
  test("derives a path-aware build identity that ignores its own attestation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-browser-artifact-"))
    try {
      await mkdir(path.join(directory, "assets"))
      await writeFile(path.join(directory, "index.html"), "<main>Claxedo</main>")
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('app')")
      const first = await browserArtifactBuildId(directory)
      await writeFile(path.join(directory, "claxedo-browser-build.json"), JSON.stringify({ browserBuildId: first }))
      expect(await browserArtifactBuildId(directory)).toBe(first)
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('changed')")
      expect(await browserArtifactBuildId(directory)).not.toBe(first)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("removes Pages-only routing and source maps before the assets Worker serves them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-worker-browser-"))
    try {
      await mkdir(path.join(directory, "assets"))
      await writeFile(path.join(directory, "_redirects"), "/* /index.html 200\n")
      await writeFile(path.join(directory, "index.html"), "worker app")
      await writeFile(path.join(directory, "assets", "app.js"), "console.log('app')")
      await writeFile(path.join(directory, "assets", "app.js.map"), "build-only metadata")
      await prepareBrowserArtifactsForWorkers(directory)
      expect((await readdir(directory)).sort()).toEqual(["assets", "index.html"])
      expect(await readdir(path.join(directory, "assets"))).toEqual(["app.js"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
