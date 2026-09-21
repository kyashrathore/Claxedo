import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createElicitationPatternEvaluator } from "./pattern-validation"
import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"

test("native worker preserves Unicode, lookaround, backreferences and substring matching", async () => {
  const evaluate = createElicitationPatternEvaluator()
  await evaluate([
    { field: "substring", pattern: "abc", value: "xabcx" },
    { field: "space", pattern: "\\s", value: "\u00a0" },
    { field: "emoji", pattern: "^.$", value: "😀" },
    { field: "lookaround", pattern: "(?<=a)(?=b)b", value: "ab" },
    { field: "backreference", pattern: "(a)\\1", value: "aa" },
  ])
  await expect(evaluate([{ field: "dot", pattern: ".", value: "\r" }])).rejects.toMatchObject({ code: "invalid_answer" })
  await expect(evaluate([{ field: "syntax", pattern: "[" }])).rejects.toMatchObject({ code: "invalid_schema" })
})

test("Node and Bun terminate catastrophic native regex under an external watchdog", async () => {
  // The parent test never evaluates the adversarial regex. The subprocess must
  // terminate its worker and exit; a promise rejection alone is insufficient.
  const program = `
    const {Worker}=require('node:worker_threads');
    const worker=new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage('ready');new RegExp('^(a+)+$','u').test('a'.repeat(100000)+'!')",{eval:true});
    worker.once('message',async()=>{let ticks=0;const pulse=setInterval(()=>ticks++,5);await new Promise(r=>setTimeout(r,60));await worker.terminate();clearInterval(pulse);if(!ticks)process.exitCode=1;else console.log('terminated');});
  `
  for (const runtime of ["node", process.execPath]) {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(runtime, ["-e", program], { stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${runtime} failed worker termination watchdog`)) }, 4000)
      child.stdout.on("data", (chunk) => { output += chunk })
      child.stderr.on("data", (chunk) => { output += chunk })
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(result).toEqual({ code: 0, output: "terminated\n" })
  }
}, 10000)

test("timeout and cancellation release the bounded worker slot", async () => {
  const evaluate = createElicitationPatternEvaluator({ executionMs: 10 })
  await expect(evaluate([{ field: "slow", pattern: "^(a+)+$", value: "a".repeat(32000) + "!" }])).rejects.toMatchObject({ code: "validation_timeout" })
  const controller = new AbortController()
  controller.abort()
  await expect(evaluate([], controller.signal)).rejects.toBeInstanceOf(ElicitationValidationError)
  await evaluate([{ field: "healthy", pattern: "^yes$", value: "yes" }])
})
