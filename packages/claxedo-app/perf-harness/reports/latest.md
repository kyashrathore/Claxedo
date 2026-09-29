# Claxedo Performance Report

Generated: 2026-09-12T12:20:40.718Z
Measurement: production web bundle in headless Chromium with synthetic route-level fixtures fulfilled over loopback. This is a renderer main-thread scheduling proxy, not actual FPS or packaged Electron compositor/GPU presentation.
Target: 120hz (frame <= 8.33ms). Floor: 60hz (frame <= 16.67ms).
Flows: 1  ·  pass: 0  ·  warn: 0  ·  fail: 1

| Flow | Renderer proxy | pooled p95 task (ms) | worst task (ms) | tasks >16.67ms | mean full-flow completion (ms) | Status | Video |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| transcript-flick | 🔴 missed-60hz | 0.38 | 59.30 | 4/804 | 400.81 | fail |  |

## Core Web Vitals

Reference machine: host machine, no emulation. These are what a user perceives — when content appeared, whether it moved, how fast the UI answered input — as opposed to the renderer-scheduling proxy above.
Caveat: API and SSE responses are fulfilled in-process from fixtures, so their latency is the profile's simulated round trip rather than a real server. Asset delivery IS really throttled, so the load metrics (LCP/FCP/TTFB) carry the bundle's true cost at this bandwidth.

| Flow | LCP (ms) | INP (ms) | CLS | FCP (ms) | TTFB (ms) | interactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fast wheel flick down a long transcript, blank viewport area per frame | 808 🟢 | n/a | 2.375 🔴 | 164 🟢 | 4 🟢 | 0 |

### LCP attribution

`LCP frozen` is what the platform would actually report: the largest paint before the first TRUSTED input. Where it reads "never froze", the flow delivered only synthetic input, LCP kept being revised for the flow's whole duration, and the LCP column above is a flow-duration proxy — not a load metric, and not comparable to the 2500/4000 ms bands.

| Flow | LCP revisions | LCP frozen (ms) | first trusted input (ms) | first synthetic input (ms) | last LCP element |
| --- | ---: | ---: | ---: | ---: | --- |
| Fast wheel flick down a long transcript, blank viewport area per frame | 4 | never froze (no trusted input) | n/a | n/a | `div[data-slot=user-message-text].ui-user-message-text "user message 1902 for transcript-flick session 1 sample outp"` |

### Layout-shift attribution

`CLS under real input` rescores the same shifts with the platform's own rule applied to the flow's synthetic clicks: a shift within 500ms after an input is the user's doing, not instability. The gap between the two columns is shift the flow charged itself for and a real user would not have seen as instability.

| Flow | CLS observed | CLS under real input | excused | shifts |
| --- | ---: | ---: | ---: | ---: |
| Fast wheel flick down a long transcript, blank viewport area per frame | 2.375 | 2.375 | 0% | 21 |

## Findings

| Flow | Note | Video |
| --- | --- | --- |
| transcript-flick | worst renderer task 59.30ms > 16.67ms — exceeded one 60hz main-thread budget |  |
| transcript-flick | 4 of 804 renderer tasks exceeded the 60hz budget (allowance 0) |  |
| transcript-flick | 5 host/browser scheduling gaps in rAF had no matching main-thread unavailability or Long Animation Frame attribution and were excluded from the app gate |  |
