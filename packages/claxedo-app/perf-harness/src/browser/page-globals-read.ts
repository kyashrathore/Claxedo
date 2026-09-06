// Readers for the shared page globals declared in `./page-globals`.
//
// `page-globals.ts` is deliberately types-only — its declarations have to be
// usable from inside a serialized `page.evaluate` callback, which cannot call
// anything that file exports — so the Node-side decoders for those same shapes
// live here instead, one module over, importing the types it decodes.
//
// A page global reaches Node as JSON, so the declaration says what the page
// wrote and these say what actually arrived.

import { optionalNumber, optionalText, readNumber, readRecords } from "../page-value"
import type { LoafSample, LoafScriptSample } from "./page-globals"

/** The `window.__loaf` buffer, as it arrives from a probe's `page.evaluate`. */
export function readLoafSamples(value: unknown): LoafSample[] {
  return readRecords(value).map((sample) => ({
    startTime: readNumber(sample.startTime),
    duration: readNumber(sample.duration),
    // Optional exactly as `LoafSample` declares: a browser without the full
    // LoAF surface omits these, and a zero here would read as a measurement.
    blockingDuration: optionalNumber(sample.blockingDuration),
    renderStart: optionalNumber(sample.renderStart),
    styleAndLayoutStart: optionalNumber(sample.styleAndLayoutStart),
    scripts: readLoafScriptSamples(sample.scripts),
  }))
}

function readLoafScriptSamples(value: unknown): LoafScriptSample[] {
  return readRecords(value).map((script) => ({
    duration: readNumber(script.duration),
    invoker: optionalText(script.invoker),
    name: optionalText(script.name),
  }))
}
