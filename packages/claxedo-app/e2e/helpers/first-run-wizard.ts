import type { Page } from "@playwright/test"

/**
 * How far each scroll region of the first-run screen overflows, in CSS
 * pixels: the document, the canvas the wizard is drawn on, and the card body.
 * The rule the wizard keeps is that the first two are never positive and the
 * third is the only one that ever is.
 */
export async function wizardOverflow(page: Page) {
  return page.evaluate(() => {
    const overflow = (element: Element | null) => (element ? element.scrollHeight - element.clientHeight : Number.NaN)
    return {
      page: overflow(document.scrollingElement),
      canvas: overflow(document.querySelector('[data-testid="first-project-canvas"]')),
      body: overflow(document.querySelector('[data-slot="onboarding-card-body"]')),
    }
  })
}
