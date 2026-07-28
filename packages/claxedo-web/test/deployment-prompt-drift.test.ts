import { describe, expect, test } from "bun:test"
import { claxedoRepositoryUrl, cloudflareDeploymentPrompt as prompt } from "../src/content/deployment"

// Drift guard for the "Deploy to Cloudflare" prompt (streams C1/C2).
//
// The prompt is copy-pasted into a fresh agent session, so every concrete fact it
// asserts — binding names, Durable Object classes, R2 buckets, cron schedules,
// compatibility flags, env vars, package scripts and pinned versions — must still
// be true of the configuration it claims to describe. This test re-derives those
// facts from the real files and fails when the two drift apart in either direction:
// a binding renamed in wrangler.toml, or a claim invented in the prompt.

const repository = new URL("../../../", import.meta.url)

const read = async (path: string) => {
  const file = Bun.file(new URL(path, repository))
  if (!(await file.exists())) throw new Error(`drift guard anchor is missing: ${path}`)
  return await file.text()
}

const json = async (path: string) => JSON.parse(await read(path)) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

const controlPlaneTomlPath = "packages/claxedo-server/wrangler.toml"
const relayTomlPath = "packages/workspace-relay/wrangler.toml"

const controlPlaneToml = await read(controlPlaneTomlPath)
const relayToml = await read(relayTomlPath)

/** Every `name = "X"` / `class_name = "Y"` pair under a `durable_objects.bindings` table. */
const durableObjectBindings = (toml: string) =>
  [...toml.matchAll(/\[\[(?:env\.\w+\.)?durable_objects\.bindings\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nclass_name\s*=\s*"([^"]+)"/g)].map(
    ([, name, className]) => ({ name: name!, className: className! }),
  )

/** Every `binding = "X"` / `bucket_name = "Y"` pair under an `r2_buckets` table. */
const r2Buckets = (toml: string) =>
  [...toml.matchAll(/\[\[(?:env\.\w+\.)?r2_buckets\]\]\s*\nbinding\s*=\s*"([^"]+)"\s*\nbucket_name\s*=\s*"([^"]+)"/g)].map(
    ([, binding, bucket]) => ({ binding: binding!, bucket: bucket! }),
  )

const crons = (toml: string) =>
  [...toml.matchAll(/^crons\s*=\s*\[([^\]]*)\]/gm)].flatMap(([, list]) => [...list!.matchAll(/"([^"]+)"/g)].map(([, cron]) => cron!))

const scalar = (toml: string, key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1]

const stringList = (toml: string, key: string) => {
  const raw = toml.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))?.[1]
  return raw === undefined ? undefined : [...raw.matchAll(/"([^"]+)"/g)].map(([, value]) => value!)
}

const unique = <T>(values: T[]) => [...new Set(values)]

/**
 * Assert the prompt mentions `value`, without dumping the whole prompt into the
 * failure output. `toContain` on a multi-kilobyte string is unreadable when it fails.
 */
const promptMentions = (value: string, what: string) => {
  expect(`${what} ${JSON.stringify(value)} present in prompt: ${prompt.includes(value)}`).toBe(
    `${what} ${JSON.stringify(value)} present in prompt: true`,
  )
}

describe("cloudflare deploy prompt: control-plane wrangler.toml", () => {
  test("names every Durable Object binding and class that is actually declared", () => {
    const bindings = durableObjectBindings(controlPlaneToml)
    expect(bindings.length).toBeGreaterThan(0)
    for (const { name, className } of bindings) {
      promptMentions(name, "durable object binding")
      promptMentions(className, "durable object class")
    }
    // Reverse direction: the pairs the prompt asserts must still exist in the config.
    expect(unique(bindings.map((b) => `${b.name}/${b.className}`)).sort()).toEqual([
      "LIVE_SYNC_ROOM/LiveSyncRoom",
      "WAKE_LANE/ClaxedoWakeLane",
      "WORKGRAPH_SETTLER/WorkGraphSettler",
    ])
    for (const claimed of ["WORKGRAPH_SETTLER to class WorkGraphSettler", "WAKE_LANE to class ClaxedoWakeLane", "LIVE_SYNC_ROOM to class LiveSyncRoom"]) {
      expect(prompt).toContain(claimed)
    }
  })

  test("names the R2 binding and both bucket names", () => {
    const buckets = r2Buckets(controlPlaneToml)
    expect(buckets.length).toBeGreaterThan(0)
    for (const { binding, bucket } of buckets) {
      promptMentions(binding, "r2 binding")
      promptMentions(bucket, "r2 bucket")
    }
    expect(unique(buckets.map((b) => b.binding))).toEqual(["CLAXEDO_DOCUMENTS"])
    expect(unique(buckets.map((b) => b.bucket)).sort()).toEqual(["claxedo-documents", "claxedo-documents-staging"])
  })

  test("quotes the cron schedule exactly, for both the top level and staging", () => {
    const declared = crons(controlPlaneToml)
    expect(declared.length).toBe(2) // [triggers] + [env.staging.triggers]; crons are not inherited
    for (const cron of unique(declared)) promptMentions(cron, "cron")
    expect(unique(declared)).toEqual(["*/15 * * * *"])
  })

  test("quotes compatibility_date and every compatibility flag", () => {
    const date = scalar(controlPlaneToml, "compatibility_date")
    expect(date).toBeDefined()
    expect(prompt).toContain(date!)

    const flags = stringList(controlPlaneToml, "compatibility_flags")
    expect(flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"])
    for (const flag of flags!) promptMentions(flag, "compatibility flag")
  })

  test("quotes the worker names and the hardcoded hosted-mode vars", () => {
    expect(scalar(controlPlaneToml, "name")).toBe("claxedo-control-plane")
    expect(controlPlaneToml).toContain('name = "claxedo-control-plane-staging"')
    expect(prompt).toContain("claxedo-control-plane")
    expect(prompt).toContain("claxedo-control-plane-staging")

    expect(controlPlaneToml).toContain('CLAXEDO_DEPLOYMENT_MODE = "hosted"')
    expect(controlPlaneToml).toContain('CLAXEDO_SIGNED_CLOUD_AUTH = "1"')
    expect(prompt).toContain('CLAXEDO_DEPLOYMENT_MODE = "hosted"')
    expect(prompt).toContain('CLAXEDO_SIGNED_CLOUD_AUTH = "1"')
  })
})

describe("cloudflare deploy prompt: workspace-relay wrangler.toml", () => {
  test("names the relay Durable Object binding and worker names", () => {
    const bindings = durableObjectBindings(relayToml)
    expect(unique(bindings.map((b) => `${b.name}/${b.className}`))).toEqual(["WORKSPACE_RELAY_ROOM/WorkspaceRelayRoom"])
    for (const { name, className } of bindings) {
      promptMentions(name, "relay durable object binding")
      promptMentions(className, "relay durable object class")
    }
    expect(scalar(relayToml, "name")).toBe("claxedo-workspace-relay")
    expect(relayToml).toContain('name = "claxedo-workspace-relay-staging"')
    expect(prompt).toContain("claxedo-workspace-relay")
    expect(prompt).toContain("claxedo-workspace-relay-staging")
  })

  test("the claim that the relay declares no compatibility flags stays true", () => {
    expect(stringList(relayToml, "compatibility_flags")).toBeUndefined()
    expect(prompt).toContain("NO compatibility_flags on the relay")
    expect(scalar(relayToml, "compatibility_date")).toBe(scalar(controlPlaneToml, "compatibility_date"))
  })

  test("points only at wrangler.toml, and the configs it warns against still exist", async () => {
    expect(prompt).toContain("packages/workspace-relay using wrangler.toml ONLY")
    expect(prompt).toContain("Never deploy wrangler-h2.toml")
    expect(prompt).toContain("fly.toml")
    // The warnings are only meaningful while the decoys are really there.
    expect(await Bun.file(new URL("packages/workspace-relay/wrangler-h2.toml", repository)).exists()).toBe(true)
    expect(await Bun.file(new URL("packages/workspace-relay/fly.toml", repository)).exists()).toBe(true)
    expect(await read("packages/workspace-relay/wrangler-h2.toml")).toContain("claxedo-workspace-relay-h2-reeval")
    expect(prompt).toContain("claxedo-workspace-relay-h2-reeval")
  })
})

describe("cloudflare deploy prompt: commands", () => {
  test("every `bun run --cwd <package> <script>` resolves to a real package script", async () => {
    const invocations = [...prompt.matchAll(/bun run --cwd (\S+) ([\w:-]+)/g)].map(([, dir, script]) => ({ dir: dir!, script: script! }))
    expect(invocations.length).toBeGreaterThan(0)
    for (const { dir, script } of invocations) {
      const pkg = await json(`${dir}/package.json`)
      expect(`${dir} :: ${script} :: ${Object.hasOwn(pkg.scripts ?? {}, script)}`).toBe(`${dir} :: ${script} :: true`)
    }
  })

  test("the worker-safe dry run still wraps the wrangler command the prompt describes", async () => {
    const pkg = await json("packages/claxedo-server/package.json")
    expect(pkg.scripts?.["check:worker-safe"]).toBe("bun run scripts/deploy/check-worker-safe.ts")
    const script = await read("packages/claxedo-server/scripts/deploy/check-worker-safe.ts")
    for (const arg of ["deploy", "--env", "staging", "--dry-run", "--outdir", "dist-worker"]) {
      expect(script).toContain(`"${arg}"`)
    }
    expect(prompt).toContain("bun run --cwd packages/claxedo-server check:worker-safe")
    expect(prompt).toContain('wrangler deploy --env staging --dry-run --outdir dist-worker')
  })

  test("the workgraph smoke exists and the prompt lists the variables it actually requires", async () => {
    const pkg = await json("packages/claxedo-server/package.json")
    expect(pkg.scripts?.["smoke:workgraph"]).toBe("bun run scripts/smoke/smoke-workgraph.ts")
    const smoke = await read("packages/claxedo-server/scripts/smoke/smoke-workgraph.ts")
    for (const name of [
      "BASE_URL",
      "CLERK_SECRET_KEY",
      "WORKGRAPH_SMOKE_USER_A_ID",
      "WORKGRAPH_SMOKE_USER_B_ID",
      "WORKGRAPH_SMOKE_ORGANIZATION_A_ID",
      "WORKGRAPH_SMOKE_ORGANIZATION_B_ID",
      "WORKGRAPH_SMOKE_RECONCILE_TOKEN",
    ]) {
      expect(`${name} in smoke: ${smoke.includes(name)}`).toBe(`${name} in smoke: true`)
      expect(`${name} in prompt: ${prompt.includes(name)}`).toBe(`${name} in prompt: true`)
    }
  })

  test("prescribes bunx over npx, and describes the wrangler pinning gap accurately", async () => {
    const wrangler = (pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) =>
      pkg.devDependencies?.wrangler ?? pkg.dependencies?.wrangler

    // Verified 2026-07-28 (stream D3): all three deploy-unit packages pin the same
    // wrangler, so `bunx wrangler` is reproducible in Units 2, 3 and 4. Each package
    // must keep a pin AND they must agree, or the prompt's single stated version lies.
    const unitPins = await Promise.all(
      ["packages/workspace-relay", "packages/claxedo-server", "packages/claxedo-app"].map(async (dir) => ({
        dir,
        pin: wrangler(await json(`${dir}/package.json`)),
      })),
    )
    for (const { dir, pin } of unitPins) {
      expect(`${dir} pins wrangler: ${pin ?? "NOTHING — bunx would fetch an unpinned version"}`).toBe(`${dir} pins wrangler: ${pin}`)
    }
    // A single shared version, because the prompt states exactly one.
    expect(unique(unitPins.map(({ pin }) => pin))).toHaveLength(1)
    promptMentions(`pinned ${unitPins[0]!.pin}`, "deploy-unit wrangler pin")

    // The sandbox container worker is deliberately held back on its own version.
    // If that freeze is lifted, the prompt's "do not fix it" paragraph must go.
    const sandboxPin = wrangler(await json("packages/claxedo-server/scripts/sandbox/cloudflare-worker/package.json"))
    expect(sandboxPin).toBeDefined()
    expect(sandboxPin).not.toBe(unitPins[0]!.pin)
    promptMentions(`wrangler ${sandboxPin}`, "frozen sandbox-worker wrangler pin")
    promptMentions(`npx --yes wrangler@${sandboxPin}`, "frozen sandbox-worker inline pin")
    expect(await read(".github/workflows/deploy-cloudflare-sandbox-worker.yml")).toContain(`wrangler@${sandboxPin}`)

    expect(prompt).toContain("bunx wrangler")
    expect(prompt).toContain("bun install")
    // `npx wrangler` may only ever appear inside prose that forbids it — never as
    // a command the reader is meant to run (i.e. never at the start of a line).
    expect(prompt.split("\n").filter((line) => line.trim().startsWith("npx "))).toEqual([])
    expect(prompt).toMatch(/Do NOT use "npx wrangler"/)
  })

  test("names the deploy units in the documented order", () => {
    // Anchor on the unit headings: the package paths are also referenced in prose
    // elsewhere, so raw indexOf over the whole prompt is not an ordering signal.
    const units = [...prompt.matchAll(/^Unit (\d) — (.*)$/gm)]
    expect(units.map(([, index]) => index)).toEqual(["1", "2", "3", "4"])

    const bodies = units.map(([, , heading], i) => {
      const start = prompt.indexOf(heading!)
      const end = i + 1 < units.length ? prompt.indexOf(units[i + 1]![2]!) : prompt.length
      return prompt.slice(start, end)
    })
    expect(bodies[0]).toContain("convex/")
    expect(bodies[1]).toContain("packages/workspace-relay")
    expect(bodies[2]).toContain("packages/claxedo-server")
    expect(bodies[3]).toContain("packages/claxedo-app")

    expect(prompt).toContain("bunx convex deploy --dry-run --typecheck enable")
    expect(prompt).toContain("bunx wrangler pages deploy dist")
    expect(prompt).toContain("bunx wrangler r2 bucket create")
    expect(prompt).toContain("CLAXEDO_SANDBOX_BUILD_ID")
  })
})

describe("cloudflare deploy prompt: fail-closed prerequisites", () => {
  // Each env var the prompt asserts must still be grep-findable in the file that
  // gives it meaning. If a var is renamed or its enforcement is deleted, this fails.
  const anchors: Record<string, string> = {
    CLAXEDO_WORKSPACE_AUTHORITY_URL: "packages/claxedo-server/src/control-plane/adapters/convex/convex-authority.ts",
    CLERK_JWT_ISSUER: "packages/claxedo-server/src/control-plane/auth.ts",
    CLERK_ISSUER_URL: "packages/claxedo-server/src/control-plane/auth.ts",
    CLERK_JWKS_URL: "packages/claxedo-server/src/control-plane/auth.ts",
    CLERK_JWT_AUDIENCE: "packages/claxedo-server/src/control-plane/auth.ts",
    CLAXEDO_SIGNED_CLOUD_AUTH: "packages/claxedo-server/src/control-plane/auth.ts",
    CLAXEDO_DEPLOYMENT_MODE: "packages/claxedo-server/src/control-plane/deployment-mode.ts",
    CLAXEDO_WORKSPACE_RELAY_URL: "packages/claxedo-server/src/control-plane/hosted-services.ts",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "packages/claxedo-server/src/control-plane/hosted-services.ts",
    CLAXEDO_RUNTIME_ADMIN_TOKEN: "packages/claxedo-server/src/control-plane/hosted-services.ts",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "packages/claxedo-server/src/control-plane/hosted-services.ts",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: "packages/claxedo-server/src/control-plane/routes/jwks.ts",
    CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "packages/claxedo-server/src/control-plane/adapters/worker/hosted-compose.ts",
    CLERK_WEBHOOK_SECRET: "convex/http.ts",
    CONVEX_DEPLOY_KEY: ".github/workflows/deploy-control-plane.yml",
    CLAXEDO_SENTRY_DSN: "packages/claxedo-server/wrangler.toml",
    CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: "packages/workspace-relay/wrangler.toml",
    CLAXEDO_CONTROL_PLANE_JWKS_URL: "packages/workspace-relay/wrangler.toml",
    VITE_CLAXEDO_SERVER_URL: ".github/workflows/deploy-claxedo-app.yml",
    VITE_CLERK_PUBLISHABLE_KEY: ".github/workflows/deploy-claxedo-app.yml",
    VITE_CONVEX_URL: ".github/workflows/deploy-claxedo-app.yml",
  }

  test.each(Object.entries(anchors))("%s is named in the prompt and still exists in its anchor file", async (name, path) => {
    expect(`${name} in prompt: ${prompt.includes(name!)}`).toBe(`${name} in prompt: true`)
    expect(`${name} in ${path}: ${(await read(path!)).includes(name!)}`).toBe(`${name} in ${path}: true`)
  })

  test("states Convex and Clerk as hard prerequisites before any Cloudflare work", () => {
    const stopLine = prompt.indexOf("READ THIS BEFORE TOUCHING CLOUDFLARE")
    expect(stopLine).toBeGreaterThan(-1)
    // Both must be introduced in the first quarter of the prompt, not buried.
    expect(prompt.indexOf("CONVEX")).toBeLessThan(prompt.length / 4)
    expect(prompt.indexOf("CLERK")).toBeLessThan(prompt.length / 4)
    expect(prompt).toContain("hosted_dependency_missing")
    expect(prompt).toContain("hosted_auth_disabled")
    expect(prompt).toContain("503 on every")
    expect(prompt).toContain("do not start deploying Workers")
  })

  test("the fail-closed error codes it quotes are the ones the worker really throws", async () => {
    const hostedServices = await read("packages/claxedo-server/src/control-plane/hosted-services.ts")
    const hostedCompose = await read("packages/claxedo-server/src/control-plane/adapters/worker/hosted-compose.ts")
    const hostedApp = await read("packages/claxedo-server/src/hosted-app.ts")
    const jwks = await read("packages/claxedo-server/src/control-plane/routes/jwks.ts")
    expect(hostedServices).toContain("hosted_auth_disabled")
    expect(hostedServices).toContain("hosted_token_reuse")
    expect(hostedCompose).toContain("hosted_dependency_missing")
    expect(hostedApp).toContain("hosted_deployment_mode_required")
    expect(jwks).toContain("jwks_no_keys_configured")
    for (const code of ["hosted_token_reuse", "hosted_deployment_mode_required", "jwks_no_keys_configured"]) {
      expect(prompt).toContain(code)
    }
  })

  test("says this is the hosted path only, and that absent mode means self-host", async () => {
    const deploymentMode = await read("packages/claxedo-server/src/control-plane/deployment-mode.ts")
    expect(deploymentMode).toContain('if (!raw || raw === "self-host") return "self-host"')
    expect(prompt).toContain("HOSTED PATH ONLY")
    expect(prompt).toContain("absent deployment mode means self-host")
  })

  test("only advertises verification endpoints the hosted app actually registers", async () => {
    const hostedApp = await read("packages/claxedo-server/src/hosted-app.ts")
    const jwks = await read("packages/claxedo-server/src/control-plane/routes/jwks.ts")
    for (const route of ["/api/claxedo/health", "/api/claxedo/mode", "/api/claxedo/compatibility"]) {
      expect(`${route} registered: ${hostedApp.includes(`"${route}"`)}`).toBe(`${route} registered: true`)
      expect(`${route} in prompt: ${prompt.includes(route)}`).toBe(`${route} in prompt: true`)
    }
    expect(jwks).toContain("/.well-known/jwks.json")
    expect(prompt).toContain("/.well-known/jwks.json")
    // The fail-closed probe must stay a 401 assertion, not a liveness check.
    expect(prompt).toContain("/api/workgraph/snapshot?limit=1")
    expect(prompt).toContain("must be exactly 401")
  })

  test("keeps the R2-buckets-first prerequisite that no workflow performs", async () => {
    const runbook = await read("public-docs/deploy-runbook.md")
    expect(runbook).toContain("CLAXEDO_DOCUMENTS")
    expect(prompt).toContain("R2 buckets must exist BEFORE the control-plane Worker deploy")
    expect(prompt).toContain("bunx wrangler r2 bucket info")
    expect(prompt).toContain("document_backend_unavailable")
  })

  test("keeps the sandbox-image prerequisite tied to the workflow that emits the build id", async () => {
    const workflow = await read(".github/workflows/claxedo-sandbox-image.yml")
    expect(workflow).toContain("CLAXEDO_SANDBOX_BUILD_ID")
    expect(prompt).toContain("claxedo-sandbox-image workflow")
    expect(prompt).toContain("CLAXEDO_SANDBOX_BUILD_ID")
  })
})

describe("cloudflare deploy prompt: self-sufficiency and honesty", () => {
  test("carries the repository so a fresh session with no checkout can start (C2)", () => {
    expect(claxedoRepositoryUrl).toBe("https://github.com/kyashrathore/Claxedo")
    expect(prompt).toContain(claxedoRepositoryUrl)
    expect(prompt).toContain(`git clone ${claxedoRepositoryUrl}.git`)
    expect(prompt).toContain("cd Claxedo")
    // Clone, cd and install must all come before the first deploy command.
    const firstDeploy = prompt.indexOf("bunx wrangler deploy")
    expect(prompt.indexOf("git clone")).toBeLessThan(firstDeploy)
    expect(prompt.indexOf("cd Claxedo")).toBeLessThan(firstDeploy)
    expect(prompt.indexOf("bun install")).toBeLessThan(firstDeploy)
  })

  test("states the real deployment status without repeating the retracted claim", () => {
    expect(prompt).not.toMatch(/never been (executed|run)/i)
    expect(prompt).not.toMatch(/has never been deployed/i)
    expect(prompt).toContain("staging deployment of exactly this shape exists")
    expect(prompt).toContain("Production has never been stood up")
    expect(prompt).toContain("Do not assume the origin repository's success transfers")
    expect(prompt).toContain("STOP and report the divergence")
  })

  test("remains a single copy-pasteable block", () => {
    expect(typeof prompt).toBe("string")
    expect(prompt.trim()).toBe(prompt.trim())
    expect(prompt.length).toBeGreaterThan(2000)
    expect(prompt).not.toContain("\r")
    expect(prompt).not.toContain("TODO")
    expect(prompt).not.toContain("<placeholder>")
  })
})
