import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * P-9: beta and stable must not share update metadata — separate feed channels
 * and artifact names, no automatic downgrades.
 */

const desktopDir = path.resolve(import.meta.dir, "..")

function builderConfig(channel: string) {
  const specifier = pathToFileURL(path.join(desktopDir, "electron-builder.config.ts")).href
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import(${JSON.stringify(specifier)}).then((m) => console.log(JSON.stringify(m.default)))`,
    ],
    cwd: desktopDir,
    env: { ...process.env, CLAXEDO_CHANNEL: channel },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(proc.exitCode).toBe(0)
  return JSON.parse(proc.stdout.toString()) as {
    appId: string
    artifactName?: string
    publish?: { channel?: string }
  }
}

describe("electron-builder update channels", () => {
  test("beta publishes its own feed and artifact names", () => {
    const beta = builderConfig("beta")
    expect(beta.publish?.channel).toBe("beta")
    expect(beta.artifactName).toContain("beta")
  })

  test("prod publishes the stable feed and artifact names", () => {
    const prod = builderConfig("prod")
    expect(prod.publish?.channel).toBe("latest")
    expect(prod.artifactName).not.toContain("beta")
  })

  test("dev does not publish", () => {
    expect(builderConfig("dev").publish).toBeUndefined()
  })
})

describe("runtime updater wiring", () => {
  test("update channel follows the build channel and downgrades stay off", async () => {
    const specifier = pathToFileURL(path.join(desktopDir, "src/main/constants.ts")).href
    const read = (channel: string) =>
      Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `import(${JSON.stringify(specifier)}).then((m) => console.log(JSON.stringify({ update: m.UPDATE_CHANNEL, enabled: m.UPDATER_ENABLED })))`,
        ],
        cwd: desktopDir,
        env: { ...process.env, CLAXEDO_CHANNEL: channel },
        stdout: "pipe",
        stderr: "pipe",
      })

    const beta = read("beta")
    expect(beta.exitCode).toBe(0)
    expect(JSON.parse(beta.stdout.toString())).toEqual({ update: "beta", enabled: true })

    const prod = read("prod")
    expect(JSON.parse(prod.stdout.toString())).toEqual({ update: "latest", enabled: true })

    const source = await Bun.file(path.join(desktopDir, "src/main/index.ts")).text()
    expect(source).toContain("autoUpdater.channel = UPDATE_CHANNEL")
    expect(source).toContain("autoUpdater.allowDowngrade = false")
    expect(source).not.toContain("allowDowngrade = true")
  })
})

const FEED_YML = [
  "version: 1.2.3",
  "files:",
  "  - url: claxedo-desktop-beta-win-x64.exe",
  "    sha512: deadbeef",
  "    size: 42",
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  "",
].join("\n")

/** Run finalize-latest-yml.ts against a stub `gh` that records its argv. */
function finalize(feed: string | undefined, ymlName: string) {
  const tmp = mkdtempSync(path.join(tmpdir(), "latest-yml-"))
  const bin = path.join(tmp, "bin")
  const feedDir = path.join(tmp, "latest-yml", "latest-yml-x86_64-pc-windows-msvc")
  mkdirSync(feedDir, { recursive: true })
  mkdirSync(bin)
  writeFileSync(path.join(feedDir, ymlName), FEED_YML)
  const ghLog = path.join(tmp, "gh.log")
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "$GH_STUB_LOG"\n`, { mode: 0o755 })

  const env = { ...process.env } as Record<string, string>
  if (feed === undefined) delete env.CLAXEDO_UPDATE_CHANNEL
  else env.CLAXEDO_UPDATE_CHANNEL = feed
  env.LATEST_YML_DIR = path.join(tmp, "latest-yml")
  env.GH_REPO = "owner/repo"
  env.CLAXEDO_VERSION = "1.2.3"
  env.RUNNER_TEMP = tmp
  env.GH_STUB_LOG = ghLog
  env.PATH = `${bin}:${env.PATH}`

  const proc = Bun.spawnSync({
    cmd: [process.execPath, "./scripts/finalize-latest-yml.ts"],
    cwd: desktopDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { proc, tmp, ghLog }
}

describe("finalize-latest-yml", () => {
  test("stable feed stays on latest.yml", () => {
    const { proc, tmp, ghLog } = finalize(undefined, "latest.yml")
    expect(proc.stderr.toString()).toBe("")
    expect(proc.exitCode).toBe(0)
    expect(existsSync(path.join(tmp, "latest.yml"))).toBe(true)
    const uploaded = readFileSync(ghLog, "utf8")
    expect(uploaded).toContain("release upload")
    expect(uploaded).toContain("latest.yml")
    expect(uploaded).not.toContain("beta.yml")
  })

  test("beta feed reads and publishes beta.yml, never latest.yml", () => {
    const { proc, tmp, ghLog } = finalize("beta", "beta.yml")
    expect(proc.exitCode).toBe(0)
    expect(existsSync(path.join(tmp, "beta.yml"))).toBe(true)
    const uploaded = readFileSync(ghLog, "utf8")
    expect(uploaded).toContain("beta.yml")
    expect(uploaded).not.toContain("latest.yml")
  })

  test("a beta run ignores stable metadata left in the same directory", () => {
    const { proc, tmp, ghLog } = finalize("beta", "latest.yml")
    expect(proc.exitCode).toBe(0)
    // No beta.yml input existed, so nothing is uploaded for the beta feed.
    expect(existsSync(ghLog)).toBe(false)
    expect(existsSync(path.join(tmp, "beta.yml"))).toBe(false)
  })
})
