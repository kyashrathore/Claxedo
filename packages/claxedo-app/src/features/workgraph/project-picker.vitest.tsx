import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { ProjectPicker } from "./project-picker"

afterEach(cleanup)

const projects = [
  { value: "/Users/dev/work/acme/app", label: "app" },
  { value: "/Users/dev/side/hobby/app", label: "app" },
]

describe("ProjectPicker", () => {
  // The trigger shows a BASENAME, so two recent projects both called `app` are
  // indistinguishable without the path. Nothing else carries it: Kobalte points
  // `aria-labelledby` at the trigger's own value, which shadows the static
  // `aria-label="Project directory"`, so the accessible name is the basename
  // too. The tooltip is the only place the path survives — and `Select` renders
  // `renderValue` for the trigger, not `children`.
  test("keeps the full path on the trigger, not just the basename", () => {
    render(() => <ProjectPicker value="/Users/dev/work/acme/app" projects={projects} onChange={() => undefined} />)

    const trigger = screen.getByRole("button")
    expect(trigger).toHaveTextContent("app")
    expect(trigger.querySelector("[title]")).toHaveAttribute("title", "/Users/dev/work/acme/app")
  })

  test("falls back to the placeholder with no selection", () => {
    render(() => <ProjectPicker value="" projects={projects} onChange={() => undefined} />)

    expect(screen.getByRole("button")).toHaveTextContent("Select a project")
  })
})
