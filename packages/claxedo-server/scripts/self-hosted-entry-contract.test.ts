import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Every self-hosted launch surface — `bun run start`, the Docker `CMD`, the Fly
 * deployment — must boot the same entry module, derived here from one constant.
 * A partial move (package script retargeted, Dockerfile not) leaves every test
 * green and the published container failing at `docker run`; nothing else in
 * the suite reads the Dockerfile.
 */

const packageRoot = path.resolve(import.meta.dirname, "..")
const repoRoot = path.resolve(packageRoot, "../..")

/** The single self-hosted entry module, relative to the package root. */
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
    // The Dockerfile's runtime-stage `NODE_OPTIONS` is not inherited by the
    // build stage, and Node sizes its default heap from the cgroup, so the app
    // build dies with `Reached heap limit` only inside Docker.
    const dockerfile = read("Dockerfile")
    const appBuild = dockerfile.slice(
      dockerfile.indexOf("cd packages/claxedo-app"),
      dockerfile.indexOf("FROM node:22-bookworm-slim AS runtime"),
    )

    expect(appBuild, "the app build stage must set its own heap").toContain("max-old-space-size")
  })

  test("the image compiles better-sqlite3 against its own glibc", () => {
    // better-sqlite3's prebuild links GLIBC_2.38; the bookworm image has 2.36,
    // so the container starts and dies at the first database open. Only
    // running the image shows it.
    const dockerfile = read("Dockerfile")

    // Scanned over RUN instructions only: the Dockerfile's own comment names
    // the command.
    const instructions = dockerfile
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")

    // `npm rebuild` inside a package directory rebuilds its dependencies and
    // produces nothing, so "some rebuild command is present" is not enough.
    expect(instructions, "the image must compile better-sqlite3 rather than trust its prebuild").toContain(
      "node-gyp rebuild",
    )
    // And prove the artifact exists at build time, so a silently skipped
    // rebuild fails the BUILD rather than the first request.
    expect(instructions).toContain("build/Release/better_sqlite3.node")
  })

  test("the public package entry exposes the self-hosted composition", () => {
    // `main`/`exports` are what `@claxedo/server` consumers resolve.
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
    // split/join: path.relative answers with backslashes on Windows.
    expect(path.relative(repoRoot, packageRoot).split(path.sep).join("/")).toBe("packages/claxedo-server")
  })
})
