/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { TimelineFocus } from "./model"
import { createTimelineLinkOpen } from "./timeline-link-open"

function opener(canReadLocalFiles: boolean) {
  const opened: TimelineFocus[] = []
  const errors: unknown[] = []
  const links = createTimelineLinkOpen({
    openFocus: (focus) => opened.push(focus),
    platform: { openLink: () => {}, openPath: async () => {}, canReadLocalFiles },
    placementPath: "/repo",
    onError: (error) => errors.push(error),
  })
  return { links, opened, errors }
}

test("an absolute artifact link keeps its line and column, the same as a workspace path", () => {
  const { links, opened, errors } = opener(true)
  links.openFile("/abs/notes.md:42")
  links.openFile("@/abs/notes.md:7:3")
  links.openFile("/abs/notes.md")
  links.openFile("/repo/src/a.ts:12")
  expect(errors).toEqual([])
  expect(opened).toEqual([
    { kind: "file", path: "/abs/notes.md", line: 42, col: undefined },
    { kind: "file", path: "/abs/notes.md", line: 7, col: 3 },
    { kind: "file", path: "/abs/notes.md" },
    { kind: "file", path: "src/a.ts", line: 12, col: undefined },
  ])
})

test("an absolute artifact link is refused where local files cannot be read", () => {
  const { links, opened, errors } = opener(false)
  links.openFile("/abs/notes.md:42")
  expect(opened).toEqual([])
  expect(errors).toHaveLength(1)
})
