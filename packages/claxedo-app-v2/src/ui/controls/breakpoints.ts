
export const BP_SM = 640
export const BP_MD = 768
export const BP_LG = 1024
export const BP_XL = 1280
export const BP_2XL = 1536

export const BP_EDITOR_WIDE = 1200
export const BP_EDITOR_COMPACT = 900
export const BP_XS = 420

export function isNarrowViewport(
  width: number | undefined = typeof window === "undefined" ? undefined : window.innerWidth,
): boolean {
  return width !== undefined && width < BP_MD
}

export function mediaQueryBelow(breakpoint: number): string {
  return `(max-width: ${breakpoint - 1}px)`
}

export const COARSE_POINTER_QUERY = "(pointer: coarse)"
