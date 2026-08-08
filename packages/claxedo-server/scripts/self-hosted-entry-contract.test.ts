import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Self-hosted launch-path contract.
 *
 * The self-hosted single-binary is a SHIPPED product: `bun run start`, the
 * Docker `CMD`, and the Fly deployment all boot one entry module. Unit 7 moves
 * that entry from `deployments/local/main.ts` to `deployments/self-hosted-node`
 * and Unit 8 deletes the old directory outright.
 *
 * The hazard is not the move — it is a PARTIAL move. Retargeting the package
 * script but not the Dockerfile produces a repository where every test passes,
 * `bun run start` works on a laptop, and the published container fails at
 * `docker run` with a module-not-found. Nothing else in the suite looks at the
 * Dockerfile, so nothing else can catch that.
 *
 * So this file asserts that every launch surface names the SAME entry, and it
 * derives that entry from one constant. Unit 7 changes the constant once and
 * every surface that disagrees fails by name.
 */

const packageRoot = path.resolve(import.meta.dirname, "..")
const repoRoot = path.resolve(packageRoot, "../..")

/**
 * The single self-hosted entry module, relative to the package root.
 *
 * Unit 7 changes this to `src/deployments/self-hosted-node/index.ts` and must
 * change `package.json`, the Dockerfile, and the smoke scripts in the same
 * slice — this test is what forces that to be one slice rather than three.
 */
const SELF_HOSTED_ENTRY = "src/deployments/self-hosted-node/index.ts"

/** The health path the container's HEALTHCHECK probes. */
const SELF_HOSTED_HEALTH_PATH = "/api/claxedo/health"

function read(rel: string) {
  return readFileSync(path.join(packageRoot, rel), "utf8")
}

const manifest = JSON.parse(read("package.json")) as {
  main: string
  exports: Record<string, unknown>
  scripts: Record<string, string>
}

describe("self-hosted entry contract", () => {
  test("package dev and start boot the self-hosted entry", () => {
    expect(manifest.scripts.dev).toContain(SELF_HOSTED_ENTRY)
    expect(manifest.scripts.start).toContain(SELF_HOSTED_ENTRY)
  })

  test("the cloud-hosted Node script boots a different entry", () => {
    // Self-hosted and cloud-hosted Node are separate products sharing one
    // package. If they ever converged on one script the self-hosted posture
    // assertion would be running against hosted boot requirements.
    expect(manifest.scripts["start:hosted"]).toContain("src/deployments/hosted-node/index.ts")
    expect(manifest.scripts["start:hosted"]).not.toContain(SELF_HOSTED_ENTRY)
  })

  test("the Docker image runs the same entry as the package scripts", () => {
    const dockerfile = read("Dockerfile")
    const cmd = dockerfile.split("\n").findLast((line) => line.startsWith("CMD "))
    expect(cmd, "Dockerfile must declare a CMD").toBeDefined()
    expect(cmd).toContain(SELF_HOSTED_ENTRY)
  })

  test("the container health check probes a path the entry actually serves", () => {
    const dockerfile = read("Dockerfile")
    expect(dockerfile).toContain(SELF_HOSTED_HEALTH_PATH)
    // The port in HEALTHCHECK, EXPOSE, and fly.toml must agree; a mismatch
    // yields a container that is permanently "unhealthy" while serving fine.
    const exposed = dockerfile.match(/^EXPOSE\s+(\d+)/m)?.[1]
    expect(exposed).toBeDefined()
    expect(dockerfile).toContain(`http://127.0.0.1:${exposed}${SELF_HOSTED_HEALTH_PATH}`)
    expect(read("fly.toml")).toContain(`internal_port = ${exposed}`)
  })

  test("the image's app build gets an explicit heap", () => {
    // Found by building the image: the app build died with
    // `FATAL ERROR: Reached heap limit` (exit 134). `NODE_OPTIONS` is set in
    // the Dockerfile, but in the RUNTIME stage — the build stage inherits
    // nothing from it.
    //
    // Nothing else can catch this. Node sizes its default heap from the
    // cgroup rather than the host, so the identical build succeeds outside
    // Docker on a 7.7GB machine and fails inside it, and every test in the
    // repository passes either way. The only signal is building the image.
    const dockerfile = read("Dockerfile")
    const appBuild = dockerfile.slice(
      dockerfile.indexOf("cd packages/claxedo-app"),
      dockerfile.indexOf("FROM node:22-bookworm-slim AS runtime"),
    )

    expect(appBuild, "the app build stage must set its own heap").toContain("max-old-space-size")
  })

  test("the public package entry exposes the self-hosted composition", () => {
    // `main`/`exports` are what `@claxedo/server` consumers resolve. Unit 7
    // replaces `createSelfHostedApp` with `createSelfHostedApp` here; until then this
    // records that the public surface is the mixed local composition.
    expect(manifest.main).toBe("./src/index.ts")
    const index = read("src/index.ts")
    expect(index).toContain('from "./deployments/self-hosted-node/app"')
    expect(index).toContain("createSelfHostedApp")
    expect(index).toContain("startControlPlaneStack")
  })

  test("the repo-root deploy documentation points at this package", () => {
    // Cheap drift catch: the Fly config is built from the monorepo root, so a
    // package rename that forgets the build context produces a deploy that
    // silently uses a stale image.
    const fly = read("fly.toml")
    expect(fly).toContain('dockerfile = "Dockerfile"')
    expect(path.relative(repoRoot, packageRoot)).toBe("packages/claxedo-server")
  })
})
