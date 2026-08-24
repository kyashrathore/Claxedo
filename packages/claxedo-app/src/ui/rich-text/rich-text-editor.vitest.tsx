import { render, waitFor } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { describe, expect, test } from "vitest"
import { RichTextEditor } from "./rich-text-editor"

describe("RichTextEditor", () => {
  test("renders a markdown value as rich ProseMirror nodes", async () => {
    const markdown = [
      "## Rollout plan",
      "",
      "- flatten the surface",
      "- reuse the **docs** editor",
      "",
      "> ship it flat",
    ].join("\n")
    const { container } = render(() => createComponent(RichTextEditor, { value: markdown }))

    const surface = await waitFor(() => {
      const el = container.querySelector(".richtext-surface.ProseMirror")
      if (!el || !el.querySelector("h2")) throw new Error("editor not ready")
      return el
    })

    expect(surface.querySelector("h2")?.textContent).toBe("Rollout plan")
    expect(surface.querySelectorAll("ul li").length).toBe(2)
    expect(surface.querySelector("strong")?.textContent).toBe("docs")
    expect(surface.querySelector("blockquote")?.textContent).toContain("ship it flat")
  })

  test("shows the placeholder only while empty", async () => {
    const { container } = render(() => createComponent(RichTextEditor, { placeholder: "Add a description…" }))
    await waitFor(() => {
      if (!container.querySelector(".richtext-surface.ProseMirror")) throw new Error("not ready")
    })
    expect(container.querySelector(".richtext-placeholder")?.textContent).toBe("Add a description…")
  })
})
