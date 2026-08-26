import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"

const CATALOG = {
  version: 1,
  categories: [
    { id: "featured", label: "Featured" },
    { id: "skills", label: "Skills" },
    { id: "mcp-servers", label: "MCP Servers" },
  ],
  entries: [
    {
      id: "acme",
      name: "Acme",
      description: "An extension",
      source: "github.com/acme/acme",
      kind: "skill",
      categories: ["skills"],
      recommendedScope: "machine",
      recommendedTargets: ["claude"],
      featured: true,
    },
    {
      // Deliberately oversized: a row must not grow a line for either field.
      id: "verbose",
      name: "An Extension With A Name Far Longer Than Any Row Should Have To Hold",
      description:
        "A description long enough that it would certainly wrap onto a second and probably a third line if the row let it, which is the whole point of clamping it.",
      source: "https://github.com/acme/verbose-extension-with-a-long-repository-name",
      kind: "mcp",
      categories: ["mcp-servers"],
      recommendedScope: "project",
      recommendedTargets: ["claude"],
      featured: true,
    },
  ],
}

function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  const body = url.includes("/catalog") ? CATALOG : {}
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

// The panel talks to claxedo-server on loopback, which routes through
// `unsignedLocalFetch` rather than the injectable `request` prop.
vi.mock("@/platform/runtime/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/runtime/transport")>()
  return { ...actual, unsignedLocalFetch: stubFetch }
})

const { MarketplacePanel } = await import("./panel")

afterEach(cleanup)

function renderAt(width: string) {
  return render(() => (
    <DialogProvider>
      <div style={{ width }}>
        <MarketplacePanel />
      </div>
    </DialogProvider>
  ))
}

/*
 * The marketplace sizes itself off its own pane via container queries, so the
 * narrow layout must be a reflow of the ONE category list — not a second copy
 * of it rendered for small widths. Two copies would leave two "Featured"
 * buttons in the accessibility tree even though CSS paints only one.
 */
describe("MarketplacePanel categories — one control per category at any width", () => {
  for (const [label, width] of [
    ["narrow pane", "360px"],
    ["wide pane", "1280px"],
  ] as const) {
    test(`${label}: every category has exactly one button`, async () => {
      renderAt(width)

      // Wait for the catalog so the server-driven categories are mounted too.
      await waitFor(() => expect(screen.getByRole("button", { name: /^Skills$/ })).toBeInTheDocument())

      for (const name of ["Featured", "All Extensions", "Installed", "On this machine", "Skills", "MCP Servers"]) {
        expect(screen.getAllByRole("button", { name })).toHaveLength(1)
      }

      // One list element, and it is the sidebar that the container query reflows.
      expect(screen.getAllByRole("complementary", { name: "Marketplace categories" })).toHaveLength(1)
      expect(document.querySelectorAll(".marketplace-sidebar")).toHaveLength(1)
    })
  }
})

/*
 * Entries are flat two-line rows, not cards. jsdom does not lay text out, so
 * this asserts the structure that makes two lines unconditional: one no-wrap
 * flex line, one clamped line, and the install control as a third sibling
 * rather than a third line. (The rendered heights were measured separately in
 * a browser: every row is 69px at both 360px and 864px pane widths, including
 * the oversized entry below.)
 */
describe("MarketplacePanel entries — flat two-line rows at any width", () => {
  for (const [label, width] of [
    ["narrow pane", "360px"],
    ["wide pane", "1280px"],
  ] as const) {
    test(`${label}: every row is exactly two lines with no card chrome`, async () => {
      renderAt(width)
      await waitFor(() => expect(document.querySelectorAll(".marketplace-row").length).toBe(2))

      for (const row of document.querySelectorAll<HTMLElement>(".marketplace-row")) {
        const lines = row.querySelector<HTMLElement>(".marketplace-row-lines")!

        // Two lines, and nothing else that could become a third.
        expect(lines.querySelectorAll(".marketplace-row-line")).toHaveLength(2)
        expect(lines.children).toHaveLength(2)

        const [first, second] = [...lines.children] as HTMLElement[]
        // Line 1 is a flex row that never wraps.
        expect(first.className).toContain("flex")
        expect(first.className).not.toContain("flex-wrap")
        // Line 2 is clamped to a single line however long the description is.
        expect(second.className).toContain("line-clamp-1")

        // Icon tile, the two lines, install control — the control is a sibling
        // of the text column, so it cannot push a line of its own.
        expect(row.children).toHaveLength(3)

        // No card chrome: the hover background is the only surface.
        expect(row.className).not.toMatch(/(^|\s)border/)
        expect(row.className).not.toMatch(/(^|\s)bg-/)
        expect(row.className).toContain("hover:bg-surface-base-hover")
      }

      // Scope and source no longer own a line; they stay reachable on the row.
      const verbose = [...document.querySelectorAll<HTMLElement>(".marketplace-row")].at(-1)!
      expect(verbose.getAttribute("title")).toBe("acme/verbose-extension-with-a-long-repository-name · Project scope")
    })
  }

  test("the entry list is a single column at every width", () => {
    renderAt("1280px")
    for (const grid of document.querySelectorAll<HTMLElement>(".marketplace-grid")) {
      expect(grid.className).not.toMatch(/grid-cols-\d/)
    }
  })
})
