import { coarsePointerMediaQuery, isPhoneWidth } from "@/lib/viewport"

export const MAX_WEBGL_RENDERERS = 12

export type RendererBudget = {
  readonly supported: () => boolean
  readonly preferDom: () => boolean
  readonly acquire: () => boolean
  readonly release: () => void
}

export function probeWebGl(doc: Pick<Document, "createElement"> | undefined = document): boolean {
  if (!doc) return false
  const canvas = doc.createElement("canvas")
  if (typeof canvas.getContext !== "function") return false
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgl")
  if (!gl) return false
  const lose = (gl as WebGLRenderingContext).getExtension?.("WEBGL_lose_context")
  lose?.loseContext?.()
  return true
}

export function preferDomRenderer(win: Pick<Window, "matchMedia" | "innerWidth"> | undefined = window): boolean {
  if (!win) return false
  if (win.matchMedia?.(coarsePointerMediaQuery)?.matches) return true
  return isPhoneWidth(win.innerWidth)
}

export function createRendererBudget(input?: { max?: number; probe?: () => boolean }): RendererBudget {
  const max = input?.max ?? MAX_WEBGL_RENDERERS
  const probe = input?.probe ?? probeWebGl
  let supported: boolean | undefined
  let active = 0
  return {
    supported: () => {
      supported ??= probe()
      return supported
    },
    preferDom: () => preferDomRenderer(),
    acquire: () => {
      if (active >= max) return false
      active += 1
      return true
    },
    release: () => {
      active = Math.max(0, active - 1)
    },
  }
}
