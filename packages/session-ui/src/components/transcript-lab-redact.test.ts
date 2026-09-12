import { describe, expect, test } from "bun:test"
import { redactMachineIdentity } from "./transcript-lab-redact"

const HOME = "/Users/ada"
const USER = "ada"

type LabPart = {
  id: string
  type: string
  tool?: string
  text?: string
  state?: {
    input: { filePath: string }
    output: string
    metadata: { loaded: string[] }
  }
}

type LabSession = {
  id: string
  title: string
  sessionID: string
  messages: {
    id: string
    role: string
    path: { cwd: string; root: string }
    tokens: { input: number; cache: { read: number; write: number | null } }
  }[]
  parts: Record<string, LabPart[]>
  stats: { proseChars: number }
}

function session(): LabSession {
  return {
    id: "toolrun",
    title: "Clicking on skill does nothing",
    sessionID: "57c90445",
    messages: [
      {
        id: "m0001",
        role: "assistant",
        path: { cwd: `${HOME}/test/opencode`, root: `${HOME}/test/opencode` },
        tokens: { input: 2, cache: { read: 11258, write: null } },
      },
    ],
    parts: {
      m0001: [
        {
          id: "p0001",
          type: "tool",
          tool: "bash",
          state: {
            input: { filePath: `${HOME}/.claude/projects/-Users-ada-test-opencode/57c90445.jsonl` },
            output: `-rw-r--r--@ 1 ada  staff  14668  9 Sep 21:09 ${HOME}/test/opencode/script/build.mjs`,
            metadata: { loaded: [`${HOME}/test/opencode/packages/wakes/src/tools.ts`] },
          },
        },
        { id: "p0002", type: "text", text: `I read ${HOME}/test/claxedo-backup/all-refs.txt, owned by adamson.` },
      ],
    },
    stats: { proseChars: 29727 },
  }
}

describe("redactMachineIdentity", () => {
  test("replaces the home directory everywhere a string reaches", () => {
    const subject = redactMachineIdentity(session(), HOME, USER)

    expect(subject.messages[0].path).toEqual({ cwd: "~/test/opencode", root: "~/test/opencode" })
    expect(subject.parts.m0001[0].state?.input.filePath).toBe(
      "~/.claude/projects/-Users-user-test-opencode/57c90445.jsonl",
    )
    expect(subject.parts.m0001[0].state?.metadata.loaded).toEqual(["~/test/opencode/packages/wakes/src/tools.ts"])
    expect(subject.parts.m0001[1].text).toContain("~/test/claxedo-backup/all-refs.txt")
    expect(JSON.stringify(subject)).not.toContain(HOME)
  })

  test("replaces the username standing on its own and leaves longer words alone", () => {
    const subject = redactMachineIdentity(session(), HOME, USER)

    expect(subject.parts.m0001[0].state?.output).toBe(
      "-rw-r--r--@ 1 user  staff  14668  9 Sep 21:09 ~/test/opencode/script/build.mjs",
    )
    expect(subject.parts.m0001[1].text).toContain("owned by adamson.")
  })

  test("carries non-string values and the shape through unchanged", () => {
    const subject = redactMachineIdentity(session(), HOME, USER)

    expect(subject.messages[0].tokens).toEqual({ input: 2, cache: { read: 11258, write: null } })
    expect(subject.stats).toEqual({ proseChars: 29727 })
    expect(Object.keys(subject)).toEqual(["id", "title", "sessionID", "messages", "parts", "stats"])
    expect(subject.parts.m0001.map((part) => part.id)).toEqual(["p0001", "p0002"])
  })

  test("leaves the username in place when there is none to replace", () => {
    const subject = redactMachineIdentity({ text: `ada at ${HOME}/x` }, HOME, "")

    expect(subject.text).toBe("ada at ~/x")
  })
})
