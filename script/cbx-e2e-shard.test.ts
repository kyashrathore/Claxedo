import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const script = path.resolve(import.meta.dir, "cbx-e2e-shard.sh")

/** Each shard emits one NUL-terminated argv record per line in dry-run mode. */
function dryRun(argv: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [script, ...argv], {
    encoding: "utf8",
    env: { ...process.env, E2E_SHARD_DRY_RUN: "1", ...env },
  })
  const records = result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\0").filter((field) => field.length > 0))
  return { ...result, records }
}

describe("cbx-e2e-shard remote command", () => {
  test("forwards args after -- as remote positional parameters, not shell text", () => {
    const { status, records } = dryRun(["e2e1", "e2e2", "--", "--grep=slow", "--grep=two words"])
    expect(status).toBe(0)
    expect(records).toHaveLength(2)

    const [first, second] = records
    expect(first.slice(0, 8)).toEqual([
      "./script/cbx",
      "run",
      "--id",
      "e2e1",
      "--no-sync",
      "--",
      "bash",
      "-c",
    ])
    const remoteScript = first[8]
    expect(remoteScript).toContain("CLAXEDO_E2E_SERVE_MODE=build-preview")
    expect(remoteScript).toContain('"--shard=$1"')
    expect(remoteScript).toContain('"${@:2}"')
    // Caller-controlled tokens never appear inside the remote shell text.
    expect(remoteScript).not.toContain("--grep")

    expect(first[9]).toBe("e2e-shard")
    expect(first[10]).toBe("1/2")
    // An arg containing a space stays a single remote argv element.
    expect(first.slice(11)).toEqual(["--grep=slow", "--grep=two words"])
    expect(second[10]).toBe("2/2")
    expect(second.slice(11)).toEqual(["--grep=slow", "--grep=two words"])
  })

  test("E2E_ARGS words reach the remote argv literally and inertly", () => {
    const { status, records } = dryRun(["e2e1"], { E2E_ARGS: "--last-failed --grep=$(id) -e x" })
    expect(status).toBe(0)
    expect(records[0].slice(10)).toEqual(["1/1", "--last-failed", "--grep=$(id)", "-e", "x"])
  })

  test("rejects box slugs that could smuggle shell syntax or paths", () => {
    for (const slug of ["bad;box", "../escape", "a b", "$(id)", ""]) {
      const { status, stderr } = dryRun([slug])
      expect(status, `slug ${JSON.stringify(slug)}`).toBe(2)
      expect(stderr).toContain("invalid crabbox box slug")
    }
  })

  test("rejects an empty box list with usage", () => {
    const { status, stderr } = dryRun([])
    expect(status).toBe(2)
    expect(stderr).toContain("usage:")
  })
})
