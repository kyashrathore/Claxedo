import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createResource, type Accessor } from "solid-js"
import { SessionComposerLoadBoundary } from "@/features/session/ui/session-progressive-surfaces"
import { createPromptPopoverController } from "./popover-controller"
import type { PromptCustomCommand } from "./prompt-options"

afterEach(() => cleanup())

const FALLBACK = '[data-component="session-prompt-dock-loading"]'

/**
 * Covers the REAL reader. `createPromptPopoverController` owns the tracked
 * `slashCommands` memo that reads `customCommands`, and `composer.tsx` hands it
 * the raw `createResource` accessor. A pending read in that memo re-arms
 * `SessionComposerLoadBoundary`, which is what made the composer vanish for
 * 75-83 ms mid cold-open before the same DOM node was reattached.
 */
function Popover(props: { customCommands: Accessor<PromptCustomCommand[] | undefined> }) {
  const controller = createPromptPopoverController({
    agents: () => [],
    recentFiles: () => [],
    searchFilesAndDirectories: async () => [],
    commandOptions: () => [],
    customCommands: props.customCommands,
    documentPicker: () => false,
    documents: () => [],
    onAtSelect: () => {},
    onSlashSelect: () => {},
  })
  // Forces the lazily-evaluated slash memo during render, as opening the popover does.
  return <div data-testid="composer">{controller.slashFlat().length}</div>
}

describe("createPromptPopoverController under SessionComposerLoadBoundary", () => {
  test("a PENDING command resource does not re-suspend the composer boundary", () => {
    const view = render(() => {
      const [pending] = createResource(() => new Promise<PromptCustomCommand[]>(() => {}))
      return (
        <SessionComposerLoadBoundary>
          <Popover customCommands={pending} />
        </SessionComposerLoadBoundary>
      )
    })
    expect(view.container.querySelector(FALLBACK)).toBeNull()
    expect(view.queryByTestId("composer")).not.toBeNull()
  })
})
