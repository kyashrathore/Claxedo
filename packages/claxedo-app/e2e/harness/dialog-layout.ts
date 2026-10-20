import type { Locator } from "@playwright/test"
import { expect } from "./fixtures"

export async function expectFieldRingUnclipped(field: Locator): Promise<void> {
  const overflow = await field.evaluate((element) => {
    const ringed = element.closest('[data-component="text-input-v2"], [data-component="textarea-v2"]') ?? element
    const style = getComputedStyle(ringed)
    const ring = style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
    const box = ringed.getBoundingClientRect()
    let clipper = ringed.parentElement
    while (clipper && getComputedStyle(clipper).overflowY === "visible") clipper = clipper.parentElement
    if (!clipper) return 0
    const outer = clipper.getBoundingClientRect()
    const top = outer.top + clipper.clientTop - clipper.scrollTop
    const left = outer.left + clipper.clientLeft
    return Math.max(top - (box.top - ring), box.bottom + ring - (top + clipper.scrollHeight), left - (box.left - ring), box.right + ring - (left + clipper.clientWidth))
  })
  expect(overflow, "the field's focus ring lies inside the box that clips it").toBeLessThanOrEqual(0)
}

export async function expectFooterAtDialogInset(dialog: Locator, button: Locator): Promise<void> {
  const [frame, title, box] = await Promise.all([dialog.boundingBox(), dialog.getByRole("heading").first().boundingBox(), button.boundingBox()])
  if (!frame || !title || !box) throw new Error("The dialog is not laid out")
  const inset = title.x - frame.x
  expect(frame.x + frame.width - (box.x + box.width), "the button keeps the header's inset from the dialog's right edge").toBeCloseTo(inset, 0)
  expect(frame.y + frame.height - (box.y + box.height), "the button keeps the header's inset from the dialog's bottom edge").toBeCloseTo(inset, 0)
}
