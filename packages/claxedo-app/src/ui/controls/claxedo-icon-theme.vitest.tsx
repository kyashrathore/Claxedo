import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import type { AppIconName } from "@/ui/icons/catalog"
import spriteMarkup from "../../../../ui/src/assets/icons/codex/sprite.svg?raw"
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
      <div data-testid="shared">
        <Icon name="folder" />
      </div>
      <div data-testid="app">
        <ClaxedoIcon name="folder" />
      </div>
      <div data-testid="app-v2">
        <ClaxedoIconV2 name="folder" />
      </div>
      <div data-testid="shared-copy">
        <Icon name="copy" />
      </div>
      <div data-testid="app-copy">
        <ClaxedoIcon name="copy" />
      </div>
      <div data-testid="shared-expand">
        <Icon name="expand" />
      </div>
      <div data-testid="app-expand">
        <ClaxedoIcon name="expand" />
      </div>
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toMatch(/\/icons\/codex\/sprite\.svg(?:\?|$)/)
      return new Response(spriteMarkup, { headers: { "content-type": "image/svg+xml" } })
    }),
  )
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  setIconLibraryPreference("auto")
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  setIconLibraryPreference("auto")
})

describe("theme-driven icon libraries", () => {
  test("honors shared artwork while keeping process and terminal artwork theme-specific", async () => {
    const names = [
      "globe",
      "cloud",
      "gauge",
      "reload",
      "reset",
      "worktree",
      "discord",
      "process",
      "terminal",
      "terminal-active",
    ] as const
    const view = render(() => (
      <>
        {names.map((name) => (
          <>
            <div data-testid={`codex-${name}`}>
              <ClaxedoIcon name={name} library="codex" />
            </div>
            <div data-testid={`opencode-${name}`}>
              <ClaxedoIconV2 name={name} library="opencode" />
            </div>
          </>
        ))}
        <div data-testid="shared-reset">
          <Icon name="reset" />
        </div>
        <div data-testid="shared-discord">
          <Icon name="discord" />
        </div>
        <div data-testid="shared-terminal">
          <Icon name="terminal" />
        </div>
        <div data-testid="shared-terminal-active">
          <Icon name="terminal-active" />
        </div>
      </>
    ))
    for (const theme of ["codex", "opencode"] as const) {
      setIconLibraryPreference(theme)
      await waitFor(() => {
        for (const name of names) {
          const themeSpecific = ["process", "terminal", "terminal-active"].includes(name)
          for (const preview of ["codex", "opencode"]) {
            const family = themeSpecific ? preview : name === "discord" ? "opencode" : "codex"
            expect(view.getByTestId(`${preview}-${name}`).querySelector("[data-library]")).toHaveAttribute(
              "data-library",
              family,
            )
          }
          if (themeSpecific) expect(symbolMarkup(view, `codex-${name}`)).not.toBe(symbolMarkup(view, `opencode-${name}`))
          else expect(symbolMarkup(view, `codex-${name}`)).toBe(symbolMarkup(view, `opencode-${name}`))
        }
        expect(symbolMarkup(view, "shared-reset")).toBe(symbolMarkup(view, "codex-reset"))
        expect(symbolMarkup(view, "shared-discord")).toBe(symbolMarkup(view, "codex-discord"))
        expect(symbolMarkup(view, "shared-terminal")).toBe(symbolMarkup(view, `${theme}-terminal`))
        expect(symbolMarkup(view, "shared-terminal-active")).toBe(symbolMarkup(view, `${theme}-terminal-active`))
        expect(symbolMarkup(view, "codex-process")).toBe(symbolMarkup(view, "codex-terminal"))
        expect(symbolMarkup(view, "opencode-process")).toBe(symbolMarkup(view, "opencode-terminal"))
      })
    }
  })

  test("preserves harness brand geometry across themes and both renderers", async () => {
    const names = ["claude", "cursor", "openai", "opencode", "pi"] as const
    const view = render(() => (
      <>
        {names.map((name) => (
          <>
            <div data-testid={`brand-app-${name}`}>
              <ClaxedoIcon name={name} />
            </div>
            <div data-testid={`brand-shared-${name}`}>
              <Icon name={name} />
            </div>
          </>
        ))}
      </>
    ))
    const artwork = new Map<string, string>()
    for (const library of ["codex", "opencode", "codex"] as const) {
      setIconLibraryPreference(library)
      await waitFor(() => {
        for (const name of names) {
          const app = symbolMarkup(view, `brand-app-${name}`)
          expect(app).toBe(symbolMarkup(view, `brand-shared-${name}`))
          if (artwork.has(name)) expect(app).toBe(artwork.get(name))
          else artwork.set(name, app)
          expect(view.getByTestId(`brand-app-${name}`).querySelector("[data-library]")).toHaveAttribute(
            "data-library",
            library,
          )
        }
      })
    }
  })

  test.each(["codex", "opencode"] as const)("keeps state transitions inside %s", async (library) => {
    setIconLibraryPreference(library)
    const [name, setName] = createSignal<AppIconName>("folders")
    const view = render(() => (
      <div data-testid="state">
        <ClaxedoIcon name={name()} />
      </div>
    ))
    const pairs = [
      ["terminal", "terminal-active"],
      ["folder", "folder-open"],
      ["expand-all", "collapse-all"],
      ["split", "unified"],
      ["layout-left-partial", "layout-left-full"],
      ["layout-right-partial", "layout-right-full"],
    ] as const
    for (const [off, on] of pairs) {
      for (const icon of [off, on, off]) {
        setName(icon)
        await waitFor(() => {
          const family = library
          expect(view.container.querySelector("[data-library]")?.getAttribute("data-library")).toBe(family)
          const href = view.container.querySelector("use")?.getAttribute("href")
          expect(href?.startsWith("#opencode-icon-")).toBe(family === "opencode")
          expect(symbolMarkup(view, "state")).toBeTruthy()
        })
      }
    }
  })

  test("switches every icon consumer live for multiple non-Codex themes", async () => {
    const view = render(() => (
      <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
        <Harness />
      </ThemeProvider>
    ))

    await assertTheme(view, "codex", "codex")

    for (const [label, id] of [
      ["Aura", "aura"],
      ["OpenCode", "opencode"],
      ["Vercel", "vercel"],
    ] as const) {
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

  test("keeps shared Markdown controls on the app's Codex copy and expand geometry", async () => {
    const view = render(() => (
      <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
        <Harness />
      </ThemeProvider>
    ))

    await assertTheme(view, "codex", "codex")
    await waitFor(() => {
      expect(symbolMarkup(view, "shared-copy")).toBe(symbolMarkup(view, "app-copy"))
      expect(symbolMarkup(view, "shared-expand")).toBe(symbolMarkup(view, "app-expand"))
    })
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

function symbolMarkup(view: ReturnType<typeof render>, id: string) {
  const href = view.getByTestId(id).querySelector("use")?.getAttribute("href")
  expect(href).toMatch(/^#.+/)
  const symbol = document.querySelector(href!)
  expect(symbol, `${id} references a missing symbol`).not.toBeNull()
  expect(
    symbol!.querySelector("path[d],rect,circle,polygon,polyline,line,ellipse"),
    `${id} has no geometry`,
  ).not.toBeNull()
  return symbol!.innerHTML
}
