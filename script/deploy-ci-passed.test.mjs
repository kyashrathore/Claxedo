import assert from "node:assert/strict"
import test from "node:test"
import { CI_RESULT_JOB, GATE_JOB, ciPassed } from "./deploy-ci-passed.mjs"

const job = (name, conclusion) => ({ name, conclusion })

await test("a commit whose earlier run passed both the gate and the CI suite needs neither again", () => {
  assert.equal(ciPassed([[job(GATE_JOB, "success"), job(CI_RESULT_JOB, "success"), job("control plane (Better Auth + D1)", "failure")]]), true)
})

await test("a gate and a CI suite that passed in different runs, or not at all, do not count", () => {
  assert.equal(ciPassed([]), false)
  assert.equal(ciPassed([[job(GATE_JOB, "success")], [job(CI_RESULT_JOB, "success")]]), false)
  assert.equal(ciPassed([[job(GATE_JOB, "success"), job(CI_RESULT_JOB, "failure")]]), false)
  assert.equal(ciPassed([[job(GATE_JOB, "skipped"), job(CI_RESULT_JOB, "success")]]), false)
})
