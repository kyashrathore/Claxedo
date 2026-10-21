import type { animate } from "motion"

export type Animate = typeof animate

export const loadToolMotion = (): Promise<Animate> => import("motion").then(({ animate }) => animate)
