import type { Plugin } from "vite"

export const FRAME_RUNTIME_MODULE = "virtual:claxedo-frame-runtime"
const RESOLVED_FRAME_RUNTIME = `\0${FRAME_RUNTIME_MODULE}`
const INLINED_CODE = /^const jsContent = ("(?:[^"\\\n]|\\.)*");/

export class FrameRuntimeBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FrameRuntimeBuildError"
  }
}

/**
 * `virtual:claxedo-frame-runtime` default-exports the plugin frame runtime's
 * code as a string, in a chunk of its own. The host posts that text into the
 * frame; on the desktop's `file:` renderer `fetch` cannot read a sibling file,
 * so a build takes the code from Vite's own `?worker&inline` bundle of the
 * entry, whose load answers `const jsContent = <JSON string>` first. That text
 * is read in a `pre` transform, before Vite's own transforms requote it. The
 * dev server builds no worker bundle, so there the module fetches the
 * worker's URL instead.
 */
export function claxedoFrameRuntime(entry: string): Plugin {
  const inlineId = `${entry}?worker&inline`
  let serving = false
  let inlined: string | undefined
  return {
    name: "claxedo:frame-runtime",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve"
    },
    resolveId(source) {
      return source === FRAME_RUNTIME_MODULE ? RESOLVED_FRAME_RUNTIME : null
    },
    transform(code, id) {
      if (id === inlineId) inlined = INLINED_CODE.exec(code)?.[1]
      return null
    },
    async load(id) {
      if (id !== RESOLVED_FRAME_RUNTIME) return null
      if (serving) return `import url from ${JSON.stringify(`${entry}?worker&url`)}\nconst response = await fetch(url)\nexport default await response.text()\n`
      await this.load({ id: inlineId })
      if (!inlined) throw new FrameRuntimeBuildError(`Vite's inline worker bundle of ${entry} no longer starts with its jsContent string`)
      return `export default ${inlined}\n`
    },
  }
}
