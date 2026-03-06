import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionSummary } from "../../src/session/summary"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function git(dir: string, command: string) {
  await $`bash -lc ${command}`.cwd(dir).quiet()
}

async function gitText(dir: string, command: string) {
  return $`bash -lc ${command}`.cwd(dir).quiet().text()
}

describe("SessionSummary.diff modes", () => {
  test("default mode remains storage-backed session diff", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const expected = [
          {
            file: "a.txt",
            before: "",
            after: "hello\n",
            additions: 1,
            deletions: 0,
            status: "added" as const,
          },
        ]
        await Storage.write(["session_diff", session.id], expected)
        const result = await SessionSummary.diff({ sessionID: session.id })
        expect(result).toEqual(expected)
      },
    })
  })

  test("uncommitted mode returns working-tree diffs", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "a.txt"), "one\n")
    await git(tmp.path, "git add a.txt")
    await git(tmp.path, "git commit -m \"add a\"")
    await Bun.write(path.join(tmp.path, "a.txt"), "one\ntwo\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionSummary.diff({ sessionID: session.id, mode: "uncommitted" })
        expect(result.some((diff) => diff.file === "a.txt" && diff.status === "modified")).toBe(true)
      },
    })
  })

  test("staged mode returns index-vs-head diffs only", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "a.txt"), "one\n")
    await git(tmp.path, "git add a.txt")
    await git(tmp.path, "git commit -m \"add a\"")
    await Bun.write(path.join(tmp.path, "a.txt"), "one\ntwo\n")
    await Bun.write(path.join(tmp.path, "b.txt"), "unstaged\n")
    await git(tmp.path, "git add a.txt")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionSummary.diff({ sessionID: session.id, mode: "staged" })
        expect(result.some((diff) => diff.file === "a.txt")).toBe(true)
        expect(result.some((diff) => diff.file === "b.txt")).toBe(false)
      },
    })
  })

  test("vs-base mode diffs against merge-base with detected default ref", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "base.txt"), "base\n")
    await git(tmp.path, "git add base.txt")
    await git(tmp.path, "git commit -m \"base\"")
    await git(tmp.path, "git checkout -b feature")
    await Bun.write(path.join(tmp.path, "base.txt"), "feature\n")
    await git(tmp.path, "git add base.txt")
    await git(tmp.path, "git commit -m \"feature change\"")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionSummary.diff({ sessionID: session.id, mode: "vs-base" })
        expect(result.some((diff) => diff.file === "base.txt" && diff.status === "modified")).toBe(true)
      },
    })
  })

  test("to-from mode returns diffs across explicit refs", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "range.txt"), "v1\n")
    await git(tmp.path, "git add range.txt")
    await git(tmp.path, "git commit -m \"v1\"")
    const fromRef = (await gitText(tmp.path, "git rev-parse HEAD")).trim()
    await Bun.write(path.join(tmp.path, "range.txt"), "v2\n")
    await git(tmp.path, "git add range.txt")
    await git(tmp.path, "git commit -m \"v2\"")
    const toRef = (await gitText(tmp.path, "git rev-parse HEAD")).trim()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionSummary.diff({ sessionID: session.id, mode: "to-from", fromRef, toRef })
        expect(result.some((diff) => diff.file === "range.txt")).toBe(true)
      },
    })
  })

  test("to-from mode rejects missing refs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect(() =>
          SessionSummary.diff({
            sessionID: session.id,
            mode: "to-from",
            fromRef: "HEAD",
          }),
        ).toThrow()
      },
    })
  })

  test("to-from mode rejects invalid refs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await expect(
          SessionSummary.diff({
            sessionID: session.id,
            mode: "to-from",
            fromRef: "invalid-from-ref",
            toRef: "invalid-to-ref",
          }),
        ).rejects.toThrow()
      },
    })
  })

  test("diff targets returns auto default and candidate refs", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "git config init.defaultBranch dev")
    await git(tmp.path, "git checkout -b dev")
    await Bun.write(path.join(tmp.path, "base.txt"), "base\n")
    await git(tmp.path, "git add base.txt")
    await git(tmp.path, "git commit -m \"base\"")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await SessionSummary.diffTargets({})
        expect(result.defaultRef.length > 0).toBe(true)
        expect(result.candidates.length > 0).toBe(true)
      },
    })
  })
})
