#!/usr/bin/env bun

import { runPackagedSmoke } from "./diagnostics-packaged-smoke"
import { runSourceSmoke } from "./diagnostics-source-smoke"

const evidence = process.argv.includes("--packaged") ? await runPackagedSmoke() : await runSourceSmoke()
const output = process.env.CLAXEDO_DIAGNOSTICS_SMOKE_OUTPUT
if (output) await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`[diagnostics-smoke] ${JSON.stringify(evidence, null, 2)}`)
