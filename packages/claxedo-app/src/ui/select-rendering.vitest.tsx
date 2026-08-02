import { cleanup, render, screen } from "@solidjs/testing-library"
import { Select } from "@opencode-ai/ui/select"
import { afterEach, describe, expect, test } from "vitest"

afterEach(cleanup)

const trigger = () => screen.getByRole("button")

describe("Select rendering", () => {
  test("renders plain string options in the trigger", () => {
    render(() => <Select options={["alpha", "beta"]} current="beta" />)

    expect(trigger()).toHaveTextContent("beta")
  })

  test("keeps custom option rows out of a plain selected-value trigger", () => {
    render(() => (
      <Select
        options={[{ id: "alpha", label: "Alpha" }]}
        current={{ id: "alpha", label: "Alpha" }}
        value={(item) => item.id}
        label={(item) => item.label}
      >
        {(item) => <span data-testid="custom-option-row">row:{item?.label}</span>}
      </Select>
    ))

    expect(trigger()).toHaveTextContent("Alpha")
    expect(trigger()).not.toHaveTextContent("row:")
  })

  test("uses renderValue only for the selected trigger value", () => {
    render(() => (
      <Select
        options={[{ id: "alpha", label: "Alpha" }]}
        current={{ id: "alpha", label: "Alpha" }}
        value={(item) => item.id}
        label={(item) => item.label}
        renderValue={(item) => <span data-testid="custom-trigger-value">value:{item.label}</span>}
      >
        {(item) => <span data-testid="custom-option-row">row:{item?.label}</span>}
      </Select>
    ))

    expect(screen.getByTestId("custom-trigger-value")).toHaveTextContent("value:Alpha")
    expect(trigger()).not.toHaveTextContent("row:")
  })

  test("preserves selected-value rendering when options are grouped", () => {
    render(() => (
      <Select
        options={[
          { id: "alpha", label: "Alpha", group: "Direct" },
          { id: "beta", label: "Beta", group: "ACP" },
        ]}
        current={{ id: "alpha", label: "Alpha", group: "Direct" }}
        value={(item) => item.id}
        label={(item) => item.label}
        groupBy={(item) => item.group}
      />
    ))

    expect(trigger()).toHaveTextContent("Alpha")
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox")
  })

  test("shows the placeholder without a current value and the label with one", () => {
    const options = [{ id: "alpha", label: "Alpha" }]
    const view = render(() => (
      <Select
        options={options}
        placeholder="Choose one"
        value={(item) => item.id}
        label={(item) => item.label}
      />
    ))

    expect(trigger()).toHaveTextContent("Choose one")
    view.unmount()

    render(() => (
      <Select options={options} current={options[0]} value={(item) => item.id} label={(item) => item.label} />
    ))
    expect(trigger()).toHaveTextContent("Alpha")
  })
})
