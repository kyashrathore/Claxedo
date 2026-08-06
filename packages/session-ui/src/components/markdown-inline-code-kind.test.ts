import { describe, expect, test } from "bun:test"
import { inlineCodeKind } from "./markdown-inline-code-kind"

describe("inlineCodeKind", () => {
  test("leaves code expressions as normal inline code", () => {
    expect(
      inlineCodeKind(
        `case "question.asked": ... input.setStore("question", question.sessionID, [question]) / splice/insert`,
      ),
    ).toBeUndefined()
    expect(inlineCodeKind(`<SessionQuestionDock request={request} ... />`)).toBeUndefined()
    expect(inlineCodeKind(`from sync.data.question + sync.data.session.`)).toBeUndefined()
    expect(inlineCodeKind(`@opencode-ai/app <StatusPopover />)`)).toBeUndefined()
    expect(inlineCodeKind(`sync.data.session`)).toBeUndefined()
    expect(inlineCodeKind(`window.api`)).toBeUndefined()
    expect(inlineCodeKind(`1.2`)).toBeUndefined()
  })

  test("detects file paths", () => {
    expect(inlineCodeKind(`app.tsx`)).toBe("path")
    expect(inlineCodeKind(`vite.config.mjs`)).toBe("path")
    expect(inlineCodeKind(`eslint.config.cjs`)).toBe("path")
    expect(inlineCodeKind(`app.d.ts`)).toBe("path")
    expect(inlineCodeKind(`component.svelte`)).toBe("path")
    expect(inlineCodeKind(`schema.graphql`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile`)).toBe("path")
    expect(inlineCodeKind(`Dockerfile.dev`)).toBe("path")
    expect(inlineCodeKind(`.gitignore`)).toBe("path")
    expect(inlineCodeKind(`Cargo.lock`)).toBe("path")
    expect(inlineCodeKind(`go.sum`)).toBe("path")
    expect(inlineCodeKind(`bun.lockb`)).toBe("path")
    expect(inlineCodeKind(`terraform.tfvars`)).toBe("path")
    expect(inlineCodeKind(`pnpm-lock.yaml`)).toBe("path")
    expect(inlineCodeKind(`src/app/entry/app.tsx`)).toBe("path")
    expect(inlineCodeKind(`./scripts/build.ts`)).toBe("path")
    expect(inlineCodeKind(`../shared/util.ts`)).toBeUndefined()
    expect(inlineCodeKind(`docs/plans/README.md`)).toBe("path")
    expect(inlineCodeKind(`packages/desktop-electron/.gitignore`)).toBe("path")
    expect(inlineCodeKind(`/Users/me/repo/packages/app/vite.config.ts`)).toBe("path")
    // The timeline's `:line[:col]` suffix travels with the chip.
    expect(inlineCodeKind(`src/app.tsx:42`)).toBe("path")
    expect(inlineCodeKind(`src/app.tsx:42:7`)).toBe("path")
    expect(inlineCodeKind(`app.tsx:42`)).toBe("path")
    expect(inlineCodeKind(`packages/opencode/bin/opencode`)).toBe("path-candidate")
    expect(inlineCodeKind(`packages/opencode/script/run-workspace-server`)).toBe("path-candidate")
  })

  // These stay visually inert until a workspace-aware host proves an exact file match.
  test("marks ambiguous slash-shaped identifiers for workspace validation", () => {
    expect(inlineCodeKind(`turn/start.effort`)).toBe("path-candidate")
    expect(inlineCodeKind(`session/status`)).toBe("path-candidate")
    expect(inlineCodeKind(`@opencode-ai/app`)).toBe("path-candidate")
    expect(inlineCodeKind(`application/json`)).toBe("path-candidate")
    expect(inlineCodeKind(`and/or`)).toBe("path-candidate")
    expect(inlineCodeKind(`n/a`)).toBe("path-candidate")
    expect(inlineCodeKind(`/api/session/active`)).toBe("path-candidate")
    expect(inlineCodeKind(`/`)).toBeUndefined()
    expect(inlineCodeKind(`/dev`)).toBeUndefined()
  })

  test("marks ambiguous directories for workspace validation", () => {
    expect(inlineCodeKind(`packages/desktop-electron`)).toBe("path-candidate")
    expect(inlineCodeKind(`src/`)).toBeUndefined()
    expect(inlineCodeKind(`./packages/session-ui/src/components`)).toBe("path-candidate")
  })

  // resolveWorkspaceFileFocus() refuses `~` — it can't be expanded client-side.
  test("leaves home-relative paths as normal inline code", () => {
    expect(inlineCodeKind(`~/.config/opencode`)).toBeUndefined()
    expect(inlineCodeKind(`~/repo/app.tsx`)).toBeUndefined()
  })

  test("detects urls", () => {
    expect(inlineCodeKind(`https://opencode.ai/docs`)).toBe("url")
    expect(inlineCodeKind(`http://localhost:4444`)).toBe("url")
    expect(inlineCodeKind(`file:///tmp/opencode`)).toBeUndefined()
    expect(inlineCodeKind(`ftp://opencode.ai/docs`)).toBeUndefined()
  })
})
