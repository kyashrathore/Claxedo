import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { PromptModelControl } from "./model-control"

describe("PromptModelControl", () => {
  test("routes an unrunnable placeholder badge to Connect instead of the model picker", () => {
    const onConnect = vi.fn()
    render(() => (
      <PromptModelControl
        harnessMode={() => false}
        paidProviderCount={() => 2}
        providerLoading={() => false}
        providerID={() => undefined}
        label={() => "Connect AI"}
        model={() => ({
          list: () => [],
          current: () => undefined,
          visible: () => true,
          set: () => undefined,
        })}
        controlStyle={() => ({})}
        chooseTitle="Choose model"
        chooseKeybind=""
        connectRequired={() => true}
        onConnect={onConnect}
        onUnpaidClick={() => undefined}
        onClose={() => undefined}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "Connect AI" }))
    expect(onConnect).toHaveBeenCalledOnce()
    expect(screen.queryByText("Big Pickle")).not.toBeInTheDocument()
  })
})
