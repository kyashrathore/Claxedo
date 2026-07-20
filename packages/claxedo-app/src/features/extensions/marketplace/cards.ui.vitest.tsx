import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DiscoveredSection, ExtensionCard, InstallButton } from "./cards"
import type { CatalogEntry, DiscoveredExtension } from "./install-flow"

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "acme",
    name: "Acme",
    description: "An extension",
    source: "github.com/acme/acme",
    kind: "skill",
    categories: ["skills"],
    recommendedScope: "machine",
    recommendedTargets: ["claude"],
    ...overrides,
  }
}

afterEach(cleanup)

describe("InstallButton disable/enable toggle — behavior 6 UI", () => {
  test("an installed + enabled package shows the Installed pill plus Disable and Uninstall controls", () => {
    const onToggleEnablement = vi.fn()
    render(() => (
      <InstallButton
        installed
        status="idle"
        enabled
        toggling={false}
        onClick={() => {}}
        onUninstall={() => {}}
        onToggleEnablement={onToggleEnablement}
      />
    ))
    expect(screen.getByText("Installed")).toBeInTheDocument()
    const disable = screen.getByRole("button", { name: "Disable" })
    expect(disable).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeInTheDocument()
    // No enable affordance while already enabled.
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull()
    fireEvent.click(disable)
    expect(onToggleEnablement).toHaveBeenCalledTimes(1)
  })

  test("an installed + disabled package shows the Disabled pill and an Enable control", () => {
    const onToggleEnablement = vi.fn()
    render(() => (
      <InstallButton
        installed
        status="idle"
        enabled={false}
        toggling={false}
        onClick={() => {}}
        onUninstall={() => {}}
        onToggleEnablement={onToggleEnablement}
      />
    ))
    expect(screen.getByText("Disabled")).toBeInTheDocument()
    const enable = screen.getByRole("button", { name: "Enable" })
    expect(enable).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull()
    fireEvent.click(enable)
    expect(onToggleEnablement).toHaveBeenCalledTimes(1)
  })

  test("a mid-flight toggle disables the control and shows progress copy", () => {
    render(() => (
      <InstallButton
        installed
        status="idle"
        enabled
        toggling
        onClick={() => {}}
        onUninstall={() => {}}
        onToggleEnablement={() => {}}
      />
    ))
    const button = screen.getByRole("button", { name: "Disabling…" })
    expect(button).toBeDisabled()
  })

  test("a not-installed package shows Install and fires onClick, never the toggle", () => {
    const onClick = vi.fn()
    render(() => (
      <InstallButton
        installed={false}
        status="idle"
        enabled
        toggling={false}
        onClick={onClick}
        onUninstall={() => {}}
        onToggleEnablement={() => {}}
      />
    ))
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Install" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe("ExtensionCard plugin kind — behavior 7 UI path", () => {
  test("renders a kind:'plugin' entry with the 'Plugin' label through the same card", () => {
    render(() => (
      <ExtensionCard
        entry={entry({ kind: "plugin", name: "Cursor Plugin" })}
        installed={false}
        status="idle"
        enabled
        toggling={false}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnablement={() => {}}
      />
    ))
    expect(screen.getByText("Cursor Plugin")).toBeInTheDocument()
    expect(screen.getByText("Plugin")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument()
  })
})

describe("DiscoveredSection per-item Adopt/Ignore — behavior 8 UI", () => {
  const items: DiscoveredExtension[] = [
    { path: "mcp.json", kind: "mcp-config", state: "discovered" },
    { path: ".claude", kind: "harness-config-dir", state: "discovered" },
  ]

  test("each row renders Adopt and Ignore controls that fire with their own item; Dismiss stays", () => {
    const onAdopt = vi.fn()
    const onIgnore = vi.fn()
    const onDismiss = vi.fn()
    render(() => (
      <DiscoveredSection items={items} pending={{}} onDismiss={onDismiss} onAdopt={onAdopt} onIgnore={onIgnore} />
    ))
    // Top-level Dismiss (local clear) is preserved.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // Two rows -> two Adopt + two Ignore controls.
    const adoptButtons = screen.getAllByRole("button", { name: "Adopt" })
    const ignoreButtons = screen.getAllByRole("button", { name: "Ignore" })
    expect(adoptButtons).toHaveLength(2)
    expect(ignoreButtons).toHaveLength(2)

    fireEvent.click(adoptButtons[0])
    expect(onAdopt).toHaveBeenCalledWith(items[0])
    fireEvent.click(ignoreButtons[1])
    expect(onIgnore).toHaveBeenCalledWith(items[1])
  })

  test("an adopted row shows the adopted status and disables its Adopt control", () => {
    render(() => (
      <DiscoveredSection
        items={[{ path: "mcp.json", kind: "mcp-config", state: "adopted" }]}
        pending={{}}
        onDismiss={() => {}}
        onAdopt={() => {}}
        onIgnore={() => {}}
      />
    ))
    expect(screen.getByRole("button", { name: "Adopted" })).toBeDisabled()
  })

  test("a pending row spins and disables both controls for that row", () => {
    render(() => (
      <DiscoveredSection
        items={[{ path: "mcp.json", kind: "mcp-config", state: "discovered" }]}
        pending={{ "mcp.json": "adopt" }}
        onDismiss={() => {}}
        onAdopt={() => {}}
        onIgnore={() => {}}
      />
    ))
    expect(screen.getByRole("button", { name: "Adopt" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Ignore" })).toBeDisabled()
  })
})
