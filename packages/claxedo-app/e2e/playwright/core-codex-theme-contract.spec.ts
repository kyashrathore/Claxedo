import { expect, test } from "@playwright/test"

test.describe("Codex theme contract @core", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`prominent surfaces match the installed Codex elevation in ${scheme} mode`, async ({ page }) => {
      await page.addInitScript((nextScheme) => {
        localStorage.setItem("opencode-theme-id", "codex")
        localStorage.setItem("opencode-color-scheme", nextScheme)
      }, scheme)
      await page.goto("/demo/index.html")
      await expect(page.locator("html")).toHaveAttribute("data-theme", "codex")

      const result = await page.evaluate(() => {
        const add = (attributes: Record<string, string>, className?: string) => {
          const node = document.createElement("div")
          Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value))
          if (className) node.className = className
          document.body.append(node)
          return node
        }
        const resolveShadow = (value: string) => {
          const probe = add({})
          probe.style.boxShadow = value
          const resolved = getComputedStyle(probe).boxShadow
          probe.remove()
          return resolved
        }

        const overlay = add({ "data-surface": "overlay", "data-overlay-shell": "menu" })
        const card = add({ "data-slot": "switcher-metadata-card" })
        const root = getComputedStyle(document.documentElement)
        const stroke = "0 0 0 0.5px color-mix(in oklab, var(--text-strong) 12%, transparent)"
        const prominent = `${stroke}, 0 3px 7.5px #0000000a, 0 0 20px #0000000d`
        const sidebar = `${stroke}, 0 3px 7.5px #00000008, 0 0 16px #00000005`

        return {
          scheme: root.colorScheme,
          stroke: resolveShadow(root.getPropertyValue("--elevation-stroke")),
          prominent: resolveShadow(root.getPropertyValue("--elevation-prominent")),
          sidebar: resolveShadow(root.getPropertyValue("--elevation-sidebar")),
          overlay: getComputedStyle(overlay).boxShadow,
          card: getComputedStyle(card).boxShadow,
          expectedStroke: resolveShadow(stroke),
          expectedProminent: resolveShadow(prominent),
          expectedSidebar: resolveShadow(sidebar),
        }
      })

      expect(result.scheme).toBe(scheme)
      expect(result.stroke).toBe(result.expectedStroke)
      expect(result.prominent).toBe(result.expectedProminent)
      expect(result.sidebar).toBe(result.expectedSidebar)
      expect(result.overlay).toBe(result.expectedProminent)
      expect(result.card).toBe(result.expectedProminent)
    })
  }

  test("component-owned geometry preserves Codex and non-Codex contracts", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("opencode-theme-id", "codex")
      localStorage.setItem("opencode-color-scheme", "dark")
    })
    await page.goto("/demo/index.html")

    const result = await page.evaluate(() => {
      // The demo fixture loads the base theme sheet without the app's extended
      // semantic-role injector. Supply the Codex dark value that production
      // emits so the composer contract is exercised at the same boundary.
      if (!getComputedStyle(document.documentElement).getPropertyValue("--composer-border").trim()) {
        document.documentElement.style.setProperty("--composer-border", "#303030")
      }
      const add = (attributes: Record<string, string>, className?: string) => {
        const node = document.createElement("div")
        Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value))
        if (className) node.className = className
        document.body.append(node)
        return node
      }
      const resolveShadow = (value: string) => {
        const probe = add({})
        probe.style.boxShadow = value
        const resolved = getComputedStyle(probe).boxShadow
        probe.remove()
        return resolved
      }
      const resolveLength = (value: string) => {
        const probe = add({})
        probe.style.width = value
        const resolved = getComputedStyle(probe).width
        probe.remove()
        return resolved
      }
      // Each probe mirrors the exact markup its component emits: since the
      // attribute-bucket conversion (edde23aa) the geometry rules for several
      // overlays match on the component's own `ui-*` class hook (the rightmost
      // compound Blink can bucket by), with `data-component` retained on the
      // markup as the locator/test hook. A probe carrying only the attribute
      // would measure nothing for those components — so every probe carries
      // whatever class its real component renders with (popover-content,
      // menu-v2-content and the data-surface shells are still attribute-keyed
      // and emit no dedicated class).
      const overlayNodes = [
        add({ "data-component": "dropdown-menu-content" }, "ui-dropdown-menu-content"),
        add({ "data-component": "context-menu-content" }, "ui-context-menu-content"),
        add({ "data-component": "popover-content" }),
        add({ "data-component": "select-content" }, "ui-select-content"),
        add({ "data-component": "tooltip" }, "ui-tooltip"),
        add({ "data-component": "menu-v2-content" }),
        add({ "data-component": "tooltip-v2" }, "ui-tooltip-v2"),
        add({ "data-surface": "overlay", "data-overlay-shell": "prompt" }),
      ]
      const dialog = add({ "data-component": "dialog" })
      const container = add({ "data-slot": "dialog-container" }, "ui-dialog-container")
      const content = add({ "data-slot": "dialog-content" }, "ui-dialog-content")
      container.append(content)
      dialog.append(container)
      overlayNodes.push(content)

      const card = add({ "data-slot": "switcher-metadata-card" })
      const composer = add({ "data-surface": "composer", "data-dock-border-underlay": "v2" })
      const sidebar = add({ "data-surface": "sidebar" })
      const root = getComputedStyle(document.documentElement)
      const codex = {
        overlays: overlayNodes.map((node) => {
          const style = getComputedStyle(node)
          return { radius: style.borderRadius, border: style.borderTopWidth, shadow: style.boxShadow }
        }),
        expectedShadow: resolveShadow(root.getPropertyValue("--elevation-prominent")),
        card: getComputedStyle(card).boxShadow,
        expectedCard: resolveShadow(root.getPropertyValue("--surface-card-shadow")),
        composer: getComputedStyle(composer).boxShadow,
        expectedComposer: resolveShadow(root.getPropertyValue("--surface-composer-shadow")),
        sidebar: getComputedStyle(sidebar).boxShadow,
        expectedSidebar: resolveShadow(root.getPropertyValue("--surface-sidebar-shadow")),
      }

      document.documentElement.dataset.theme = "aura"
      const auraRoot = getComputedStyle(document.documentElement)
      const dropdown = getComputedStyle(overlayNodes[0])
      const contextMenu = getComputedStyle(overlayNodes[1])
      const menuV2 = getComputedStyle(overlayNodes[5])
      const tooltipV2 = getComputedStyle(overlayNodes[6])
      const aura = {
        geometryInput: auraRoot.getPropertyValue("--surface-overlay-radius").trim(),
        dropdown: {
          radius: dropdown.borderRadius,
          expectedRadius: resolveLength(auraRoot.getPropertyValue("--radius-md")),
          border: dropdown.borderTopWidth,
        },
        contextMenu: { border: contextMenu.borderTopWidth, shadow: contextMenu.boxShadow },
        expectedContextShadow: resolveShadow(auraRoot.getPropertyValue("--shadow-xs-border")),
        menuV2: { radius: menuV2.borderRadius, shadow: menuV2.boxShadow },
        expectedMenuV2Shadow: resolveShadow(auraRoot.getPropertyValue("--v2-elevation-floating")),
        tooltipV2Radius: tooltipV2.borderRadius,
      }

      return { codex, aura }
    })

    for (const overlay of result.codex.overlays) {
      expect(overlay.radius).toBe("10px")
      expect(overlay.border).toBe("0px")
      expect(overlay.shadow).toBe(result.codex.expectedShadow)
    }
    expect(result.codex.card).toBe(result.codex.expectedCard)
    expect(result.codex.composer).toBe(result.codex.expectedComposer)
    expect(result.codex.sidebar).toBe(result.codex.expectedSidebar)
    expect(result.aura.geometryInput).toBe("")
    expect(result.aura.dropdown.radius).toBe(result.aura.dropdown.expectedRadius)
    expect(result.aura.contextMenu.border).toBe("0px")
    expect(result.aura.contextMenu.shadow).toBe(result.aura.expectedContextShadow)
    expect(result.aura.menuV2.radius).toBe("6px")
    expect(result.aura.menuV2.shadow).toBe(result.aura.expectedMenuV2Shadow)
    expect(result.aura.tooltipV2Radius).toBe("4px")
  })

  test("forced colors replaces suppressed elevation with a visible edge", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("opencode-theme-id", "codex")
      localStorage.setItem("opencode-color-scheme", "dark")
    })
    await page.emulateMedia({ forcedColors: "active" })
    await page.goto("/demo/index.html")

    const result = await page.evaluate(() => {
      const overlay = document.createElement("div")
      overlay.dataset.surface = "overlay"
      overlay.dataset.overlayShell = "menu"
      document.body.append(overlay)
      const style = getComputedStyle(overlay)
      return {
        borderStyle: style.borderTopStyle,
        borderWidth: style.borderTopWidth,
        shadow: style.boxShadow,
      }
    })

    expect(result.borderStyle).toBe("solid")
    expect(result.borderWidth).toBe("1px")
    expect(result.shadow).toBe("none")
  })
})
