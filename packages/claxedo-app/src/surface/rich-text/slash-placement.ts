export const SLASH_MENU_HEIGHT = 300

export type SlashMenuPlacement = { readonly left: string; readonly top: string }

type Box = Pick<DOMRect, "left" | "top" | "bottom">

export function slashMenuPlacement(anchor: Box, frame: Pick<DOMRect, "left" | "top">, viewportHeight: number): SlashMenuPlacement {
  const below = anchor.bottom + 4 + SLASH_MENU_HEIGHT <= viewportHeight
  const top = below ? anchor.bottom + 4 - frame.top : anchor.top - 4 - SLASH_MENU_HEIGHT - frame.top
  return { left: `${Math.round(anchor.left - frame.left)}px`, top: `${Math.round(top)}px` }
}
