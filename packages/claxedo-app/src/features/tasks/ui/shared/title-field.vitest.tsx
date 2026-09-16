import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { TaskTitleField } from "./title-field"

afterEach(cleanup)

function mount(options: { form?: boolean } = {}) {
  const [value, setValue] = createSignal("")
  const onSubmit = vi.fn((event: Event) => event.preventDefault())
  const field = () => (
    <TaskTitleField testId="title" ariaLabel="Task title" placeholder="Title" value={value()} onInput={setValue} />
  )
  render(() => (options.form ? <form onSubmit={onSubmit}>{field()}</form> : field()))
  return { value, onSubmit, field: screen.getByTestId("title") }
}

describe("the task title field", () => {
  test("is a one-row textarea that hands back a single line", () => {
    const { field, value } = mount()

    expect(field.tagName).toBe("TEXTAREA")
    expect(field.getAttribute("rows")).toBe("1")

    fireEvent.input(field, { target: { value: "Ship the\nimporter\r\nnow" } })

    expect(value()).toBe("Ship the importer now")
  })

  test("Enter submits the enclosing form instead of breaking the line", () => {
    const { field, onSubmit } = mount({ form: true })

    const keydown = fireEvent.keyDown(field, { key: "Enter" })

    expect(keydown).toBe(false)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test("Enter is inert on a page with no form", () => {
    const { field } = mount()

    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false)
    expect(fireEvent.keyDown(field, { key: "a" })).toBe(true)
  })
})
