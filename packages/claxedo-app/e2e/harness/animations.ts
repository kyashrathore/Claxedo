import { expect, type Page } from "@playwright/test"

function runningAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const name =
          animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? `transition ${animation.transitionProperty}` : animation.id || "scripted"
        const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null
        const target = effect?.target
        if (!target) return name
        const owner = target.closest("[data-component], [data-testid]")
        const where = owner?.getAttribute("data-component") ?? owner?.getAttribute("data-testid")
        return `${name} on ${target.tagName.toLowerCase()}${target.classList.length ? `.${[...target.classList].join(".")}` : ""}${effect.pseudoElement ?? ""}${where ? ` in ${where}` : ""}`
      }),
  )
}

export async function expectNothingAnimating(page: Page): Promise<void> {
  await expect.poll(() => runningAnimations(page), { message: "animations still running once the page settled" }).toEqual([])
}
