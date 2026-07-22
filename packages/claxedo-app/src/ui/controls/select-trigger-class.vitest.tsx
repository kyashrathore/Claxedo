import { cleanup, render, screen } from "@solidjs/testing-library"
import { Select } from "@opencode-ai/ui/select"
import { afterEach, describe, expect, test } from "vitest"

describe("Select surface classes", () => {
  afterEach(() => cleanup())

  test("keeps trigger and portalled content styles isolated", async () => {
    render(() => (
      <Select
        options={["alpha"]}
        current="alpha"
        forceMount
        triggerClass="trigger-only"
        contentClass="content-only"
      />
    ))

    const trigger = screen.getByRole("button", { name: "alpha" })
    expect(trigger).toHaveClass("trigger-only")
    expect(trigger).not.toHaveClass("content-only")

    const option = await screen.findByRole("option", { name: "alpha" })
    const content = option.closest('[data-component="select-content"]')
    expect(content).toHaveClass("content-only")
    expect(content).not.toHaveClass("trigger-only")
    expect(option).not.toHaveClass("trigger-only", "content-only")
  })
})
