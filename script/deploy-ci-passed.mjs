import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const GATE_JOB = "lint, typecheck, CI policy, architecture ratchets"
export const CI_RESULT_JOB = "CI suite / CI result"

/**
 * Whether an earlier staging deploy run already passed the deploy gate and the
 * CI suite for this exact commit, so a dispatched redeploy of one component
 * need not run them again. Both jobs must have succeeded in the same run.
 */
export function ciPassed(runs) {
  return runs.some((jobs) => [GATE_JOB, CI_RESULT_JOB].every((name) => jobs.some((job) => job.name === name && job.conclusion === "success")))
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`)
  return response.json()
}

async function earlierRunsJobs({ token, repository, sha, runId }) {
  const { workflow_runs: runs } = await github(`/repos/${repository}/actions/workflows/deploy-staging.yml/runs?head_sha=${sha}&per_page=20`, token)
  const earlier = runs.filter((run) => String(run.id) !== String(runId))
  return Promise.all(earlier.map(async (run) => (await github(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`, token)).jobs))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const event = process.env.GITHUB_EVENT_NAME
  const passed = event === "workflow_dispatch" && ciPassed(await earlierRunsJobs({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
  }))
  console.log(`ci_passed=${passed}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ci_passed=${passed}\n`)
}
