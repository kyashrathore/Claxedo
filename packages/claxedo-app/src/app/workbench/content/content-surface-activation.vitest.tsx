// Reproduction: does a MOUNTED ContentRenderer follow the content-surface
// registry when the hosted contribution set is registered (activation) and
// removed again (sign-out)?
//
// Both halves of `createHostedContributionPort` reach the DOM through exactly
// one call — `contentSurface(...)` inside `ContentRenderer` — so a renderer
// that resolves its surface once and never again turns activation into a
// permanent "Unknown content type" and deactivation into hosted UI that keeps
// running in a signed-out window.

import { describe, expect, test, afterEach, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { render, screen } from "@solidjs/testing-library"
import { IdentityProvider } from "@/platform/auth/identity-provider"
import type { ContentMeta } from "../state/index"
import type { PaneCtx } from "../workbench/index"
import {
  contentSurface,
  registerContentSurface,
  unregisterContentSurface,
  type ContentSurfaceContribution,
} from "../../integrations/first-party-content-surfaces"

const [meta, setMeta] = createSignal<ContentMeta | undefined>(undefined)

vi.mock("@claxedo/app", () => ({
  useServer: () => ({ url: "https://claxedo.test" }),
}))

vi.mock("../state/index", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useClaxedoState: () => ({
    meta: {
      ids: () => (meta() ? [meta()!.id] : []),
      get: (id: string) => (meta()?.id === id ? meta() : undefined),
    },
  }),
}))

const { ContentRenderer } = await import("./index")

const HOSTED_SURFACE_ID = "surface.content.test-hosted-page"

function hostedContribution(): ContentSurfaceContribution {
  return {
    id: HOSTED_SURFACE_ID,
    tier: "claxedo-first-party",
    surface: "page",
    slot: "workbench",
    renderer: () => (<div data-testid="hosted-surface">hosted page</div>) as JSX.Element,
  }
}

const paneCtx: PaneCtx = {
  paneId: "pane-1",
  isFocused: () => true,
  isVisible: () => true,
  requestClose: () => {},
  requestFocus: () => {},
}

function mountRenderer(content: ContentMeta) {
  setMeta(content)
  return render(() => (
    <IdentityProvider principal={{ kind: "anonymous" }}>
      <ContentRenderer id={content.id} ctx={paneCtx} />
    </IdentityProvider>
  ))
}

/** Ids currently resolvable for a content type — the collection, not a substring. */
function surfaceIdsFor(type: string) {
  const surface = contentSurface(type, {})
  return surface ? [surface.id] : []
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  unregisterContentSurface(hostedContribution())
  setMeta(undefined)
})

describe("ContentRenderer follows the content-surface registry", () => {
  test("hosted content resolved before activation renders once the hosted set registers", async () => {
    const utils = mountRenderer({ id: "content-page", type: "page", scope: "global" })

    // Pre-condition: the local build cannot render this type yet.
    expect(surfaceIdsFor("page")).toEqual([])
    expect(screen.queryByTestId("hosted-surface")).toBeNull()
    expect(utils.container.textContent).toBe("Unknown content type: page")

    registerContentSurface(hostedContribution())
    await tick()

    // Positive control: the registry really does hold the hosted surface now,
    // so anything still missing from the DOM is a reactivity failure.
    expect(surfaceIdsFor("page")).toEqual([HOSTED_SURFACE_ID])
    expect(screen.queryByTestId("hosted-surface")).not.toBeNull()
    expect(utils.container.textContent).not.toBe("Unknown content type: page")
  })

  test("mounted hosted content stops rendering once the hosted set is unregistered", async () => {
    registerContentSurface(hostedContribution())
    const utils = mountRenderer({ id: "content-page", type: "page", scope: "global" })

    expect(surfaceIdsFor("page")).toEqual([HOSTED_SURFACE_ID])
    expect(screen.queryByTestId("hosted-surface")).not.toBeNull()

    unregisterContentSurface(hostedContribution())
    await tick()

    // Positive control: the registry no longer offers a page surface.
    expect(surfaceIdsFor("page")).toEqual([])
    expect(screen.queryByTestId("hosted-surface")).toBeNull()
    expect(utils.container.textContent).toBe("Unknown content type: page")
  })

  // Reactivity must not be bought with re-mounts: long-lived per-content state
  // (xterm scrollback, editor selection) lives inside these renderers, so an
  // unrelated registration must leave a resolved surface exactly where it is.
  test("unrelated registry churn does not re-mount an already-resolved surface", async () => {
    let renders = 0
    const counted: ContentSurfaceContribution = {
      ...hostedContribution(),
      renderer: () => {
        renders += 1
        return (<div data-testid="hosted-surface">hosted page</div>) as JSX.Element
      },
    }
    registerContentSurface(counted)
    mountRenderer({ id: "content-page", type: "page", scope: "global" })
    expect(renders).toBe(1)

    const unrelated: ContentSurfaceContribution = {
      id: "surface.content.test-unrelated",
      tier: "claxedo-first-party",
      surface: "test-unrelated",
      slot: "workbench",
      renderer: () => (<div data-testid="unrelated-surface" />) as JSX.Element,
    }
    registerContentSurface(unrelated)
    await tick()
    unregisterContentSurface(unrelated)
    await tick()

    expect(renders).toBe(1)
    expect(screen.queryByTestId("hosted-surface")).not.toBeNull()
  })
})
