// The contract between Node-side harness code and the page it drives.
//
// Everything the harness installs on `window` inside `page.evaluate` is a
// contract with two ends: the module that writes it and the module that reads
// it. Before this file each end declared its own shape inline
// (`window as unknown as { __loaf: ... }`), so the two ends could disagree and
// nothing said so — `__loaf` had three different declared shapes across three
// probes, and the LoAF fields were re-cast out of `PerformanceEntry` at every
// use.
//
// Rules:
//   - A page global read or written by MORE THAN ONE module is declared here.
//   - A page global private to one module is declared in that module, in its
//     own `declare global` block, next to the types it stores. Never a cast.
//
// These declarations are types only: they erase completely, so they are usable
// from inside a serialized `page.evaluate` callback, which cannot call anything
// this file exports.

/**
 * One long-animation-frame observation, projected to fields that survive the
 * `page.evaluate` serialization boundary.
 *
 * A live `PerformanceEntry` does not: it crosses as `{}`. Probes therefore
 * project inside the page and return these.
 */
export type LoafSample = {
  startTime: number
  duration: number
  /**
   * Optional exactly as the underlying entry fields are: a browser without the
   * full LoAF surface omits them, and the probes report that absence rather
   * than substituting a zero that reads as a real measurement.
   */
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts: LoafScriptSample[]
}

/** One script attributed to a long animation frame. */
export type LoafScriptSample = {
  duration: number
  invoker?: string
  name?: string
}

/**
 * The whole-document style-recalculation meter the style probes install.
 *
 * `debug-style-floor-attribution.ts` installs it and
 * `debug-icon-wrapper-ablation.ts` installs its own copy; both read it back
 * through many `page.evaluate` calls, so the shape is stated once here.
 */
export type FloorMeter = {
  /** Time `samples` whole-document style invalidations, without layout. */
  time: (samples?: number) => { min: number; median: number }
  /** Count every element in the document, shadow trees included. */
  count: () => number
}

/**
 * One named phase of the app's own session-open sequence, as reported by the
 * app's `measureRendererPhase` instrumentation.
 *
 * A sampled profile says which FUNCTION ran; these say which PHASE it ran in.
 */
export type RendererPhase = { name: string; durationMs: number }

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

  /**
   * Event Timing L2's interaction grouping, which the installed `lib.dom` also
   * predates. Optional for the same reason as the LoAF fields above.
   *
   * @see https://w3c.github.io/event-timing/#dom-performanceeventtiming-interactionid
   */
  interface PerformanceEventTiming {
    readonly interactionId?: number
  }

  /**
   * One element whose box moved in a layout shift.
   *
   * @see https://w3c.github.io/layout-instability/#sec-layout-shift-attribution
   */
  interface LayoutShiftAttribution {
    readonly node?: Node | null
    readonly previousRect: DOMRectReadOnly
    readonly currentRect: DOMRectReadOnly
  }

  /**
   * Layout Instability's fields, also absent from the installed `lib.dom`.
   * Present on `layout-shift` entries and absent elsewhere, so optional.
   *
   * @see https://w3c.github.io/layout-instability/
   */
  interface PerformanceEntry {
    readonly value?: number
    readonly hadRecentInput?: boolean
    readonly sources?: readonly LayoutShiftAttribution[]
  }

  interface Window {
    /**
     * Long animation frames captured across one measured interval.
     *
     * Armed and drained by `probes/loaf-check.ts`, `probes/loaf-sweep.ts` and
     * `probes/warm-switch-probe.ts`. Each arms it fresh, so only one probe's
     * samples are ever in it.
     */
    __loaf?: LoafSample[]
    /** The observer filling {@link Window.__loaf}, kept so a re-arm can disconnect it. */
    __loafObserver?: PerformanceObserver

    /** The style-recalculation meter; see {@link FloorMeter}. */
    __floor?: FloorMeter

    /**
     * Set while the app's own renderer-phase instrumentation is armed.
     *
     * Armed by `src/real-web-harness.ts` and by `startRecorder`; the app checks
     * it before paying for two `performance.now()` readings per phase.
     */
    __claxedoPerfTrace?: boolean
    /** Pre-created by whoever arms the trace, so the app's tracer has somewhere to push. */
    __claxedoPerfRendererPhases?: RendererPhase[]

    /**
     * The panel content element observed before a session switch, held across
     * the switch so the destination can be checked for reuse or disposal.
     *
     * Written by `src/browser/scenarios/session-switch-workspace.ts` and read
     * by the session-switch probes that share its setup.
     */
    __claxedoPerfOldPanelContent?: HTMLElement
  }
}
