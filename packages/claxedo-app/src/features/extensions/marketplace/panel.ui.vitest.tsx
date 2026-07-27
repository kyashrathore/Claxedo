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
  for (const [label, width] of [["narrow pane", "360px"], ["wide pane", "1280px"]] as const) {
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
