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
            onOpenWorkGraph={() => undefined}
          />
        )}
      />
    </MemoryRouter>
  ))
}

describe("GlobalNavigation", () => {
  test("renders WorkGraph immediately after Marketplace for the shared desktop/mobile rail", () => {
    renderAt("/")
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "New project",
      "Pages",
      "Marketplace",
      "WorkGraph",
    ])
  })

  test("marks the nav item matching the current route as the current page", () => {
    renderAt("/workgraph")
    expect(screen.getByRole("button", { name: "Open WorkGraph" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("button", { name: "Open Marketplace" })).not.toHaveAttribute("aria-current")
  })
})
