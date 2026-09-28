import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createElicitationPatternEvaluator } from "./pattern-evaluator"

test("Node and Bun terminate catastrophic pattern validation under an external watchdog", async () => {
  const evaluator = new URL("./pattern-evaluator.ts", import.meta.url).href
  const program = `
    import { createElicitationPatternEvaluator } from ${JSON.stringify(evaluator)};
    const evaluate = createElicitationPatternEvaluator({ executionMs: 20 });
    let ticks = 0;
    const pulse = setInterval(() => ticks++, 5);
    try {
      await evaluate([{field: 'slow', pattern: '^(a+)+$', value: 'a'.repeat(100000) + '!'}]);
      throw new Error('adversarial pattern unexpectedly completed');
    } catch (error) {
      if (error.code !== 'validation_timeout') throw error;
    } finally { clearInterval(pulse); }
    if (!ticks) throw new Error('event loop stopped');
    await evaluate([{field: 'healthy', pattern: '^yes$', value: 'yes'}]);
    console.log('terminated');
  `
  for (const runtime of ["node", "bun"]) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const args = runtime === "node" ? ["--import", "tsx", "--input-type=module", "-e", program] : ["-e", program]
      const child = spawn(runtime, args, { stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${runtime} failed worker termination watchdog`)) }, 4_000)
      child.stdout.on("data", (chunk) => { output += chunk })
      child.stderr.on("data", (chunk) => { output += chunk })
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(result).toEqual({ code: 0, output: "terminated\n" })
  }
}, 10_000)

test("timeout, pre-aborted validation, and active cancellation release bounded worker slots", async () => {
  const checks = [{ field: "slow", pattern: "^(a+)+$", value: "a".repeat(32_000) + "!" }]
  await expect(createElicitationPatternEvaluator({ executionMs: 10 })(checks)).rejects.toMatchObject({ code: "validation_timeout" })
  const evaluate = createElicitationPatternEvaluator({ executionMs: 2_000 })
  const preAborted = AbortSignal.abort()
  await expect(evaluate([], preAborted)).rejects.toMatchObject({ code: "validation_cancelled" })
  const controllers = [new AbortController(), new AbortController()]
  const running = controllers.map((controller) => evaluate(checks, controller.signal))
  const settled = Promise.allSettled(running)
  const busy = evaluate([]).then(() => undefined, (error: unknown) => error)
  for (const controller of controllers) controller.abort()
  expect(await busy).toMatchObject({ code: "validation_busy" })
  expect(await settled).toEqual(controllers.map(() => ({ status: "rejected", reason: expect.objectContaining({ code: "validation_cancelled" }) })))
  await Promise.all([1, 2].map(() => evaluate([{ field: "healthy", pattern: "^yes$", value: "yes" }])))
})
