import { chromium } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readOptions } from "./options"
import { PROFILES, describeProfile } from "./profiles"
import { writeReport } from "./report"
import { hostLoad, runScenarios, type StepResult } from "./scenarios"
import { discoverSessions, urlTarget, type Target } from "./target"
import { localTarget } from "./target-local"

async function main() {
  const options = readOptions(process.argv.slice(2))
  const startedAt = new Date()
  await fs.mkdir(options.out, { recursive: true })
  const logFile = path.join(options.out, `${options.label}.log`)
  const log = (line: string) => {
    const stamped = `[web-perf ${new Date().toISOString().slice(11, 19)}] ${line}`
    console.log(stamped)
    void fs.appendFile(logFile, `${stamped}\n`)
  }
  log(`host ${os.cpus().length} cores, ${hostLoad()}; profiles ${options.profiles.map((name) => `${name} (${describeProfile(PROFILES[name])})`).join("; ")}`)
  const browser = await chromium.launch({ channel: "chromium" })
  let target: Target | undefined
  try {
    if (options.target === "local") target = await localTarget({ seedTurns: options.seedTurns, railSessions: options.railSessions, log })
    else {
      const partial = await urlTarget({ url: options.target, cookieFile: options.cookies ?? "" })
      target = { ...partial, sessions: await discoverSessions(browser, partial) }
    }
    log(`measuring ${target.description}; sessions ${target.sessions.map((session) => session.id).join(", ")}`)
    const results: StepResult[] = []
    for (let rep = 0; rep < options.reps; rep += 1) {
      for (const name of options.profiles) {
        const profile = PROFILES[name]
        target.useProfile(profile)
        results.push(...(await runScenarios({ browser, target, profile, cpu: options.cpu, rep, out: options.out, label: options.label, log })))
      }
    }
    const written = await writeReport(options.out, {
      label: options.label, target: target.description, profiles: options.profiles, reps: options.reps, cpu: options.cpu,
      startedAt: startedAt.toISOString(), elapsedMs: Date.now() - startedAt.getTime(), host: `${os.cpus()[0]?.model ?? "unknown"} ×${os.cpus().length}, ${hostLoad()}`,
    }, results, target.bytes)
    log(`wrote ${written.md} and ${written.json} after ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s`)
  } finally {
    await browser.close()
    await target?.close()
  }
}

await main()
