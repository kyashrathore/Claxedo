import { describe, expect, test } from "vitest"
import { render, screen } from "@solidjs/testing-library"
import { createRouter, memoryHistory } from "@solidjs/router"
import { GlobalNavigation } from "./global-navigation"

function renderAt(path: string) {
  const Router = createRouter({
    history: memoryHistory(path),
    routes: [
      {
        path: "*",
        component: () => (
          <GlobalNavigation
            newProjectLabel="New project"
            onOpenPages={() => undefined}
            onOpenMarketplace={() => undefined}
            onOpenWorkGraph={() => undefined}
          />
        ),
      },
    ],
  })
  return render(() => (
    <Router>{(props) => props.children}</Router>
  ))
}

describe("GlobalNavigation", () => {
  test("renders WorkGraph immediately after Marketplace for the shared desktop/mobile rail", () => {
    renderAt("/")
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "New project",
      "Documents",
      "Marketplace",
      "WorkGraph",
    ])
  })

  test("omits product surfaces whose composition supplied no action", () => {
    const Router = createRouter({
      history: memoryHistory("/"),
      routes: [
        {
          path: "*",
          component: () => (
            <GlobalNavigation newProjectLabel="New project" onOpenMarketplace={() => undefined} />
          ),
        },
      ],
    })
    render(() => <Router>{(props) => props.children}</Router>)

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "New project",
      "Marketplace",
    ])
    expect(screen.queryByRole("button", { name: "Open Documents" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Open WorkGraph" })).toBeNull()
  })

  test("marks the nav item matching the current route as the current page", () => {
    renderAt("/workgraph")
    const workgraph = screen.getByRole("button", { name: "Open WorkGraph" })
    const marketplace = screen.getByRole("button", { name: "Open Marketplace" })

    expect(workgraph).toHaveAttribute("aria-current", "page")
    expect(workgraph.querySelector("[data-icon-interaction]")).toHaveAttribute("data-icon-interaction", "persistent")
    expect(marketplace).not.toHaveAttribute("aria-current")
    expect(marketplace.querySelector("[data-icon-interaction]")).toHaveAttribute("data-icon-interaction", "passive")
  })
})
