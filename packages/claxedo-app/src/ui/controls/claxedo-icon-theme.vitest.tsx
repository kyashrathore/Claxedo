import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { Icon } from "@opencode-ai/ui/icon"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setIconLibraryPreference, syncIconLibraryWithTheme } from "@/ui/icons/config"
import { ClaxedoIcon, ClaxedoIconV2 } from "./claxedo-icon"

function Harness() {
  const theme = useTheme()
  return (
    <>
      <button onClick={() => theme.setTheme("aura")}>Aura</button>
      <button onClick={() => theme.setTheme("opencode")}>OpenCode</button>
      <button onClick={() => theme.setTheme("vercel")}>Vercel</button>
      <button onClick={() => theme.setTheme("codex")}>Codex</button>
      <div data-testid="shared"><Icon name="folder" /></div>
      <div data-testid="app"><ClaxedoIcon name="folder" /></div>
      <div data-testid="app-v2"><ClaxedoIconV2 name="folder" /></div>
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
  setIconLibraryPreference("auto")
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  setIconLibraryPreference("auto")
})

describe("theme-driven icon libraries", () => {
  test("switches every icon consumer live for multiple non-Codex themes", async () => {
    const view = render(() => (
      <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
        <Harness />
      </ThemeProvider>
    ))

    await assertTheme(view, "codex", "codex")

    for (const [label, id] of [["Aura", "aura"], ["OpenCode", "opencode"], ["Vercel", "vercel"]] as const) {
      fireEvent.click(view.getByRole("button", { name: label }))
      await assertTheme(view, id, "opencode")
    }

    fireEvent.click(view.getByRole("button", { name: "Codex" }))
    await assertTheme(view, "codex", "codex")
  })

  test("supports a non-persistent explicit override and auto reset", async () => {
    const view = render(() => (
      <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
        <Harness />
      </ThemeProvider>
    ))

    setIconLibraryPreference("opencode")
    await assertTheme(view, "codex", "opencode")
    expect(localStorage.getItem("opencode-icon-library")).toBeNull()

    setIconLibraryPreference("auto")
    await assertTheme(view, "codex", "codex")
  })
})

async function assertTheme(view: ReturnType<typeof render>, theme: string, library: "codex" | "opencode") {
  await waitFor(() => {
    expect(document.documentElement.dataset.theme).toBe(theme)
    for (const id of ["shared", "app", "app-v2"]) {
      expect(view.getByTestId(id).querySelector("[data-library]")?.getAttribute("data-library")).toBe(library)
    }
  })
}
