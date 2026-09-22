import { z } from "zod"

// This preload runs unsandboxed in an isolated world that Chromium lets compile
// code from strings until the document's CSP takes effect, then refuses. Zod
// probes `new Function` once, at its first parse, and caches the answer, so a
// probe that ran early leaves every later object parse throwing "Code
// generation from strings disallowed for this context". Opting out before any
// schema is built removes the probe and the fast path together.
z.config({ jitless: true })
