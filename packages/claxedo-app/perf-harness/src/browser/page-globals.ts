// The contract between Node-side harness code and the page it drives.
//
// Rules:
//   - A page global read or written by MORE THAN ONE module is declared here.
//   - A page global private to one module is declared in that module, in its
//     own `declare global` block, next to the types it stores. Never a cast.
//
// These declarations are types only: they erase completely, so they are usable
// from inside a serialized `page.evaluate` callback, which cannot call anything
// this file exports.

export type PaintedFrame<T> = {
  sample: (startedAt: number) => T
  painted: (value: T, paintedAt: number) => boolean | void
}

export type PaintedFrames = <T>(frame: PaintedFrame<T>) => () => void

declare global {
  /**
   * One script attributed to a long animation frame.
   *
   * @see https://w3c.github.io/long-animation-frames/#sec-PerformanceScriptTiming
   */
  interface PerformanceScriptTiming extends PerformanceEntry {
    readonly invoker?: string
    readonly invokerType?: string
    readonly sourceURL?: string
    readonly sourceFunctionName?: string
    readonly sourceCharPosition?: number
    readonly forcedStyleAndLayoutDuration?: number
  }

  /**
   * The Long Animation Frames API, which `lib.dom` does not yet describe.
   *
   * Declared as optional members of `PerformanceEntry` because that is the
   * truth at runtime: the observer hands back `PerformanceEntry`, and these
   * fields are present on `long-animation-frame` entries and absent on the
   * rest. Optional members express exactly that, so readers get the fields
   * without asserting an entry is something the type system cannot check.
   *
   * @see https://w3c.github.io/long-animation-frames/
   */
  interface PerformanceEntry {
    readonly blockingDuration?: number
    readonly renderStart?: number
    readonly styleAndLayoutStart?: number
    readonly scripts?: readonly PerformanceScriptTiming[]
  }

  interface Window {
    __claxedoPaintedFrames?: PaintedFrames
  }
}
