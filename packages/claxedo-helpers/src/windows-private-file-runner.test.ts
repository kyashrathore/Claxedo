import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createPrivateFileRunner, RunnerRefusal } from "./windows-private-file-runner"

/**
 * The runner's client against a stand-in that speaks the same protocol, so
 * queueing, answer handling and replacement are proved on every platform. What
 * the real runner does to a file is proved in `windows-private-file.test.ts`.
 */

const FAKE = join(import.meta.dirname, "windows-private-file-runner.test-support.ts")
const RUNNER = join(import.meta.dirname, "windows-private-file-runner.ts")
const bytes = (value: string) => new TextEncoder().encode(value)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claxedo-private-runner-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeRunner(timing = { answerTimeoutMs: 5_000, abortGraceMs: 1_000 }) {
  const launches: number[] = []
  const write = createPrivateFileRunner({
    launch: () => {
      const child = spawn(process.execPath, [FAKE], { stdio: ["pipe", "pipe", "pipe"] })
      launches.push(child.pid!)
      return child
    },
    ...timing,
  })
  const request = (name: string, contents = name) => ({
    target: join(dir, name),
    staging: join(dir, `.${name}.tmp`),
    contents: bytes(contents),
  })
  return { write, launches, request }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exited(pid: number) {
  const deadline = Date.now() + 5_000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(25)
  return !alive(pid)
}

describe("the private-file runner client", () => {
  test("serves a second write from the runner the first one started", async () => {
    const { write, launches, request } = fakeRunner()

    await write(request("first.json"))
    await write(request("second.json"))

    expect(launches).toHaveLength(1)
    expect(readFileSync(join(dir, "first.json"), "utf8")).toBe("first.json")
    expect(readFileSync(join(dir, "second.json"), "utf8")).toBe("second.json")
  })

  test("concurrent writes each publish their own complete contents", async () => {
    const { write, launches, request } = fakeRunner()
    const names = ["a.json", "b.json", "c.json", "d.json"]
    const contents = (name: string) => `${name}:`.repeat(50_000)

    await Promise.all(names.map((name) => write(request(name, contents(name)))))

    expect(launches).toHaveLength(1)
    for (const name of names) expect(readFileSync(join(dir, name), "utf8")).toBe(contents(name))
  })

  test("a refused request fails alone and the runner keeps serving", async () => {
    const { write, launches, request } = fakeRunner()

    const error = await write(request("refuse-me.json")).catch((thrown: unknown) => thrown)
    await write(request("after.json"))

    expect(error).toBeInstanceOf(RunnerRefusal)
    expect(String(error)).toContain("the staging file could not be created")
    expect(launches).toHaveLength(1)
    expect(readFileSync(join(dir, "after.json"), "utf8")).toBe("after.json")
  })

  test("a hook that throws aborts its own request and leaves the runner serving", async () => {
    const { write, launches, request } = fakeRunner()
    const failure = new Error("the caller refused to continue")

    await expect(write({ ...request("cancelled.json"), beforeWrite: () => { throw failure } })).rejects.toThrow(failure)
    await write(request("after.json"))

    expect(launches).toHaveLength(1)
    expect(readdirSync(dir)).toEqual(["after.json"])
  })

  test("a hook that outlives the bound is aborted and the runner keeps serving", async () => {
    const { write, launches, request } = fakeRunner({ answerTimeoutMs: 300, abortGraceMs: 1_000 })

    const error = await write({ ...request("slow.json"), beforeWrite: () => Bun.sleep(1_000) })
      .catch((thrown: unknown) => thrown)
    await write(request("after.json"))

    expect(error).toBeInstanceOf(RunnerRefusal)
    expect(String(error)).toContain("no answer within 300ms")
    expect(launches).toHaveLength(1)
    expect(existsSync(join(dir, "slow.json"))).toBe(false)
  })

  test("a runner that dies mid-request fails that request and the next one gets a fresh runner", async () => {
    const { write, launches, request } = fakeRunner()

    const error = await write(request("die-before-ready-x.json")).catch((thrown: unknown) => thrown)
    await write(request("after.json"))

    expect(error).toBeInstanceOf(RunnerRefusal)
    expect(String(error)).toContain("the runner exited with 3")
    expect(launches).toHaveLength(2)
    expect(readFileSync(join(dir, "after.json"), "utf8")).toBe("after.json")
  })

  test("half of PUBLISHED from a runner that then dies is not a publish", async () => {
    const { write, launches, request } = fakeRunner()

    const error = await write(request("die-mid-answer-x.json")).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(RunnerRefusal)
    expect(String(error)).toContain("the runner exited with 4")
    await write(request("after.json"))
    expect(launches).toHaveLength(2)
  })

  test("a wedged runner fails its request at the bound and is replaced", async () => {
    const { write, launches, request } = fakeRunner({ answerTimeoutMs: 500, abortGraceMs: 500 })

    const error = await write(request("wedge-x.json")).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(RunnerRefusal)
    expect(String(error)).toContain("no answer within 500ms")
    expect(await exited(launches[0]!)).toBe(true)
    await write(request("after.json"))
    expect(launches).toHaveLength(2)
  })

  test("a runner that reports the stream lost is replaced", async () => {
    const { write, launches, request } = fakeRunner()

    const error = await write(request("fatal-x.json")).catch((thrown: unknown) => thrown)
    await write(request("after.json"))

    expect(String(error)).toContain("the caller sent an unrecognised request")
    expect(launches).toHaveLength(2)
  })

  test("an idle runner does not keep its process alive, and exits with it", async () => {
    const script = join(dir, "idle.ts")
    writeFileSync(
      script,
      [
        `import { spawn } from "node:child_process"`,
        `import { join } from "node:path"`,
        `import { createPrivateFileRunner } from ${JSON.stringify(pathToFileURL(RUNNER).href)}`,
        `let holder = 0`,
        `const write = createPrivateFileRunner({`,
        `  launch: () => spawn(process.execPath, [${JSON.stringify(FAKE)}], { stdio: ["pipe", "pipe", "pipe"] }),`,
        `  answerTimeoutMs: 5_000,`,
        `  abortGraceMs: 1_000,`,
        `})`,
        `const dir = ${JSON.stringify(dir)}`,
        `await write({ target: join(dir, "t.json"), staging: join(dir, ".t.tmp"), contents: new Uint8Array([1]), beforeWrite: (report) => { holder = report.holder ?? 0 } })`,
        `process.stdout.write(String(holder))`,
      ].join("\n"),
    )

    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000 })

    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    const holder = Number(result.stdout)
    expect(holder).toBeGreaterThan(0)
    expect(readFileSync(join(dir, "t.json"))).toEqual(Buffer.from([1]))
    expect(await exited(holder)).toBe(true)
  }, 30_000)
})
