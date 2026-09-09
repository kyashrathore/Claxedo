import { expect, test } from "bun:test"
import { appliedIconReplacements, openCodeDraftArtwork } from "./icon-mapping-audit"
import nativeCodex from "../assets/icons/codex-alternatives/manifest.json"
import openCode from "../assets/icons/opencode/manifest.json"
import openCodeV2 from "../assets/icons/opencode-v2/manifest.json"

test("replacement proposals resolve within their own extracted family or labelled draft", () => {
  for (const proposal of Object.values(appliedIconReplacements)) {
    if (proposal?.codex) expect(nativeCodex.icons.some((icon) => icon.id === proposal.codex!.native)).toBe(true)
    const oc = proposal?.opencode
    if (!oc) continue
    expect(oc.library).toBe("opencode")
    if ("draft" in oc) expect(openCodeDraftArtwork[oc.draft]).toContain('stroke="currentColor"')
    else expect((oc.version === "v2" ? openCodeV2 : openCode).icons.some((icon) => icon.name === oc.name)).toBe(true)
  }
})

test("folder states keep the same silhouette and diff pairs both use native OpenCode v2", () => {
  expect(appliedIconReplacements.folders?.codex?.native).toBe("folder-on-folder-light-16")
  expect(appliedIconReplacements["file-tree"]).toBeUndefined()
  expect(appliedIconReplacements["file-tree-active"]).toBeUndefined()
  for (const name of ["expand-all", "collapse-all", "split", "unified"]) {
    expect(appliedIconReplacements[name]?.opencode).toMatchObject({ library: "opencode", version: "v2" })
  }
})
