import { describe, expect, test } from "vitest"
import { render, screen } from "@solidjs/testing-library"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { GlobalNavigation } from "./global-navigation"

function renderAt(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path })
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <GlobalNavigation
            newProjectLabel="New project"
            onOpenPages={() => undefined}
            onOpenMarketplace={() => undefined}
          />
        )}
      />
    </MemoryRouter>
  ))
}

describe("GlobalNavigation", () => {
  test("renders Documents then Marketplace for the shared desktop/mobile rail", () => {
    renderAt("/")
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "New project",
      "Documents",
      "Marketplace",
    ])
  })

  test("marks the nav item matching the current route as the current page", () => {
    renderAt("/marketplace")
    const marketplace = screen.getByRole("button", { name: "Open Marketplace" })
    const documents = screen.getByRole("button", { name: "Open Documents" })

    expect(marketplace).toHaveAttribute("aria-current", "page")
    expect(marketplace.querySelector("[data-icon-interaction]")).toHaveAttribute("data-icon-interaction", "persistent")
    expect(documents).not.toHaveAttribute("aria-current")
    expect(documents.querySelector("[data-icon-interaction]")).toHaveAttribute("data-icon-interaction", "passive")
  })
})
