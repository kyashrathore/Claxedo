import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { PromptModelControl } from "./model-control"

const emptyModel = () => ({
  list: () => [],
  current: () => undefined,
  visible: () => true,
  set: () => undefined,
})

function baseProps(overrides: Partial<Parameters<typeof PromptModelControl>[0]> = {}) {
  return {
    harnessMode: () => false,
    paidProviderCount: () => 2,
    providerLoading: () => false,
    providerID: () => undefined,
    label: () => "Connect AI",
    model: emptyModel,
    controlStyle: () => ({}),
    chooseTitle: "Choose model",
    chooseKeybind: "",
    connectRequired: () => true,
    onConnect: () => undefined,
    onUnpaidClick: () => undefined,
    onClose: () => undefined,
    showVariantSelector: () => false,
    variantTitle: "Cycle thinking effort",
    variantKeybind: "",
    variants: () => ["default", "high"],
    currentVariant: () => "default" as string | undefined,
    variantLabel: (value: string) => (value === "default" ? "Default" : value),
    onVariantSelect: () => undefined,
    ...overrides,
  } satisfies Parameters<typeof PromptModelControl>[0]
}

describe("PromptModelControl", () => {
  test("routes an unrunnable placeholder badge to Connect instead of the model picker", () => {
    const onConnect = vi.fn()
    render(() => <PromptModelControl {...baseProps({ onConnect })} />)

    fireEvent.click(screen.getByRole("button", { name: "Connect AI" }))
    expect(onConnect).toHaveBeenCalledOnce()
    expect(screen.queryByText("Big Pickle")).not.toBeInTheDocument()
  })

  // The visual contract of merging model and effort: the pair reads as ONE
  // control, which means exactly one chevron between them. The model half owns
  // it alone; as soon as the effort half appears, the effort half owns it.
  test("the model half keeps its own chevron only while no effort half is rendered", () => {
    const view = render(() => <PromptModelControl {...baseProps({ showVariantSelector: () => false })} />)

    const modelTrigger = view.container.querySelector('[data-action="prompt-model"]')!
    expect(modelTrigger.querySelectorAll('[data-component="icon"]')).toHaveLength(1)
    expect(view.container.querySelector('[data-action="prompt-model-variant"]')).toBeNull()
  })

  test("the effort half renders alongside the model and takes over the chevron", () => {
    const view = render(() => <PromptModelControl {...baseProps({ showVariantSelector: () => true })} />)

    const modelTrigger = view.container.querySelector('[data-action="prompt-model"]')!
    expect(modelTrigger.querySelectorAll('[data-component="icon"]')).toHaveLength(0)

    const variantTrigger = view.container.querySelector('[data-action="prompt-model-variant"]')!
    expect(variantTrigger).not.toBeNull()
    expect(variantTrigger.textContent).toContain("Default")
    expect(variantTrigger.querySelectorAll('[data-component="icon"]')).toHaveLength(1)
  })

  test("harness mode hides the model and effort halves together", () => {
    const view = render(() => (
      <PromptModelControl {...baseProps({ harnessMode: () => true, showVariantSelector: () => true })} />
    ))

    expect(view.container.querySelector('[data-action="prompt-model"]')).toBeNull()
    expect(view.container.querySelector('[data-action="prompt-model-variant"]')).toBeNull()
  })
})
