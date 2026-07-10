import { describe, expect, test } from "bun:test"
import path from "node:path"
import { COMPOSER_MODE_OWNER_FILE, promptInputMountsMissingExplicitMode } from "./composer-mode"
import { walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("composer mode guard", () => {
  test("keeps every PromptInput mount site on an explicit ComposerMode", () => {
    const offenders = promptInputMountsMissingExplicitMode(walkProdSources(appRoot)).map(
      (file) => `${file}: pass an explicit ComposerMode via PromptInput's mode prop`,
    )

    expect(offenders).toEqual([])
  })

  test("flags a bare PromptInput mount and does not flag a mount carrying an explicit mode prop", () => {
    expect(
      promptInputMountsMissingExplicitMode([
        { path: "shell/bare-mount.tsx", text: `function A() { return <PromptInput onSubmit={() => {}} /> }` },
        { path: "shell/explicit-mount.tsx", text: `function B() { return <PromptInput mode="edit" /> }` },
      ]),
    ).toEqual(["shell/bare-mount.tsx"])
  })

  test("does not let an earlier compliant mount mask a later bare mount in the same file", () => {
    expect(
      promptInputMountsMissingExplicitMode([
        {
          path: "shell/two-mounts.tsx",
          text: `
            function A() { return <PromptInput mode="edit" onSubmit={() => {}} /> }
            function B() { return <PromptInput /> }
          `,
        },
      ]),
    ).toEqual(["shell/two-mounts.tsx"])
  })

  test("does not flag a multiline mount whose mode prop appears on its own line", () => {
    expect(
      promptInputMountsMissingExplicitMode([
        {
          path: "shell/multiline.tsx",
          text: `
            function A() {
              return (
                <PromptInput
                  onSubmit={() => {}}
                  mode="edit"
                />
              )
            }
          `,
        },
      ]),
    ).toEqual([])
  })

  test("never flags the composer's own definition file", () => {
    expect(
      promptInputMountsMissingExplicitMode([
        { path: COMPOSER_MODE_OWNER_FILE, text: `function Composer() { return <PromptInput /> }` },
      ]),
    ).toEqual([])
  })

  test("does not flag a component whose name merely starts with PromptInput", () => {
    expect(
      promptInputMountsMissingExplicitMode([
        { path: "shell/wrapper.tsx", text: `function A() { return <PromptInputWrapper /> }` },
      ]),
    ).toEqual([])
  })
})
