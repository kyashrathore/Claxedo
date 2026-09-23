import { createMediaQuery } from "@solid-primitives/media"
import type { Accessor } from "solid-js"

export const PHONE_MAX_WIDTH = 767

export const phoneMediaQuery = `(max-width: ${PHONE_MAX_WIDTH}px)`

export const coarsePointerMediaQuery = "(pointer: coarse)"

export function usePhone(): Accessor<boolean> {
  return createMediaQuery(phoneMediaQuery)
}

export function useCoarsePointer(): Accessor<boolean> {
  return createMediaQuery(coarsePointerMediaQuery)
}

export function isPhoneWidth(width: number): boolean {
  return width > 0 && width <= PHONE_MAX_WIDTH
}
