import { describe, expect, test } from "vitest"

import {
  concurrentReleaseProcesses,
  parseStagingLedgerState,
  requireConsolidatedDeployment,
  stagingLedgerSql,
  stagingReleaseIdentity,
  stagingReleasePredecessor,
  verifyOpenRelease,
} from "./staging-release"

const COMMIT = "9f3c1a7be4d25087ab6f0c1d2e3f4a5b6c7d8e9f"

function ledger(row: Record<string, unknown>) {
  return JSON.stringify([{ success: true, results: [row] }])
}

const openLedger = {
  activeStateRevision: 204,
  activeReleaseId: "release-acc-mkt7-260905-000000-3851",
  activePhase: "open",
  activePhaseRevision: 1,
  activeReleaseSequence: 84,
  maxStateRevision: 204,
  activeWorkerBuildId: "sha256:worker",
  activePlatformVersionId: "11111111-2222-3333-4444-555555555555",
  activeBrowserBuildId: "sha256:browser",
  activeRelayBuildId: "relay-absent-v1",
  activeAuthConfigurationId: "sha256:auth",
  activeRequestLimiterNamespaceId: "2101",
}

describe("staging ledger read", () => {
  test("carries the active release's identity, which is what finishes a locked row", () => {
    const state = parseStagingLedgerState(ledger({ ...openLedger, activePhase: "locked", activePhaseRevision: 0 }))

    expect(state.activeIdentity).toEqual({
      CLAXEDO_WORKER_BUILD_ID: "sha256:worker",
      CLAXEDO_PLATFORM_VERSION_ID: "11111111-2222-3333-4444-555555555555",
      CLAXEDO_BROWSER_BUILD_ID: "sha256:browser",
      CLAXEDO_RELAY_BUILD_ID: "relay-absent-v1",
      CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth",
      CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: "2101",
    })
  })

  test("refuses a row that cannot say what its active release is", () => {
    const { activeWorkerBuildId: _omitted, ...withoutWorker } = openLedger

    expect(() => parseStagingLedgerState(ledger(withoutWorker))).toThrow("activeWorkerBuildId")
  })


  test("scopes both the active row and the history high-water mark to one deployment", () => {
    const sql = stagingLedgerSql("acc-stg-260830-232009-3851")

    expect(sql).toContain(`"active"."deploymentId" = 'acc-stg-260830-232009-3851'`)
    expect(sql).toContain(`max("stateRevision") from "deploymentReleaseStateHistory"`)
    expect(sql).toContain(`"active"."singleton" = 1`)
  })

  test("quotes a deployment id that carries an apostrophe", () => {
    expect(stagingLedgerSql("acc'stg")).toContain(`= 'acc''stg'`)
  })

  test("reads the predecessor from the active pointer, not the newest history row", () => {
    const state = parseStagingLedgerState(ledger(openLedger))

    expect(stagingReleasePredecessor(state)).toEqual({
      previousReleaseId: "release-acc-mkt7-260905-000000-3851",
      previousStateRevision: 204,
      previousPhase: "open",
      previousPhaseRevision: 1,
      releaseSequence: 85,
    })
  })

  test("refuses a stranded candidate row above the active revision with the rollback recipe", () => {
    const state = parseStagingLedgerState(ledger({ ...openLedger, maxStateRevision: 205 }))

    expect(() => stagingReleasePredecessor(state)).toThrow(/--rollback-candidate/)
  })

  test("refuses a locked active phase and names dev-open", () => {
    const state = parseStagingLedgerState(ledger({ ...openLedger, activePhase: "locked", activePhaseRevision: 0 }))

    expect(() => stagingReleasePredecessor(state)).toThrow(/--dev-open/)
  })

  test("refuses a ledger row whose sequence is not a positive integer", () => {
    expect(() => parseStagingLedgerState(ledger({ ...openLedger, activeReleaseSequence: 0 }))).toThrow(
      /non-integer revision or sequence/,
    )
  })

  test("refuses a ledger row that is missing a column", () => {
    const { activePhase: _omitted, ...withoutPhase } = openLedger

    expect(() => parseStagingLedgerState(ledger(withoutPhase))).toThrow(/missing an active release column/)
  })

  test("refuses an empty result set rather than inventing a predecessor", () => {
    expect(() => parseStagingLedgerState(JSON.stringify([{ success: true, results: [] }]))).toThrow(
      /exactly one row/,
    )
  })
})

describe("staging release identity", () => {
  test("mints a release, operation and journey id bound to the commit and the minute", () => {
    const identity = stagingReleaseIdentity({ now: new Date("2026-09-22T07:40:05.000Z"), commitSha: COMMIT })

    expect(identity.releaseId).toBe("release-staging-260922-074005-9f3c1a7b")
    expect(identity.operationId).toBe("operation-release-staging-260922-074005-9f3c1a7b")
    expect(identity.canaryJourneyId).toBe("journey-release-staging-260922-074005-9f3c1a7b")
  })

  test("mints a release id the deployment manifest path accepts", () => {
    const identity = stagingReleaseIdentity({ now: new Date("2026-01-02T03:04:05.000Z"), commitSha: COMMIT })

    expect(identity.releaseId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
  })

  test("mints a descriptor expiry far enough out that an idle staging stays reachable", () => {
    const now = new Date("2026-09-22T07:40:05.000Z")
    const identity = stagingReleaseIdentity({ now, commitSha: COMMIT })

    expect(Number(identity.authDescriptorExpiresAt) - now.getTime()).toBe(90 * 24 * 60 * 60 * 1000)
  })

  test("refuses an abbreviated commit SHA", () => {
    expect(() => stagingReleaseIdentity({ now: new Date(), commitSha: "9f3c1a7b" })).toThrow(/full git commit SHA/)
  })
})

describe("deployment consolidation", () => {
  test("accepts a single-version deployment and answers the incumbent", () => {
    expect(
      requireConsolidatedDeployment(
        { versions: [{ version_id: "d6b50ff0-e01d-4b84-b7ee-374d2e346611", percentage: 100 }] },
        "claxedo-user-deployed-locked-staging",
      ),
    ).toBe("d6b50ff0-e01d-4b84-b7ee-374d2e346611")
  })

  test("refuses a split deployment with the exact consolidation command", () => {
    expect(() =>
      requireConsolidatedDeployment(
        {
          versions: [
            { version_id: "d6b50ff0-e01d-4b84-b7ee-374d2e346611", percentage: 100 },
            { version_id: "11111111-2222-3333-4444-555555555555", percentage: 0 },
          ],
        },
        "claxedo-user-deployed-locked-staging",
      ),
    ).toThrow(
      "Consolidate first: wrangler versions deploy 'd6b50ff0-e01d-4b84-b7ee-374d2e346611@100%' --name claxedo-user-deployed-locked-staging --yes",
    )
  })
})

describe("concurrent release detection", () => {
  const ps = [
    " 4011 /usr/bin/node /repo/node_modules/.bin/vitest run",
    " 4210 bun run scripts/deploy/release-better-auth-d1.ts --staging --cutover --deploy",
    " 4300 bun scripts/deploy/staging-release.ts --staging",
  ].join("\n")

  test("names a live release process so its successor CAS inputs are never raced", () => {
    expect(concurrentReleaseProcesses(ps, 4300)).toEqual([
      "4210 bun run scripts/deploy/release-better-auth-d1.ts --staging --cutover --deploy",
    ])
  })

  test("names a live prepare process", () => {
    expect(
      concurrentReleaseProcesses(" 4400 /usr/local/bin/bun run scripts/deploy/prepare-better-auth-d1.ts --dev-open", 4300),
    ).toHaveLength(1)
  })

  test("does not report itself", () => {
    expect(concurrentReleaseProcesses(" 4300 bun scripts/deploy/staging-release.ts --staging", 4300)).toEqual([])
  })

  test("does not report the shell that carries this invocation in its own command line", () => {
    const wrapper = ` 4299 /bin/zsh -c cd /repo && bun scripts/deploy/staging-release.ts --dry-run --staging`

    expect(concurrentReleaseProcesses(wrapper, 4300)).toEqual([])
  })

  test("ignores unrelated processes", () => {
    expect(concurrentReleaseProcesses(" 4011 /usr/bin/node /repo/node_modules/.bin/vitest run", 4300)).toEqual([])
  })
})

describe("open release verification", () => {
  const RELEASE_ID = "release-staging-260922-074005-9f3c1a7b"
  const VERSION_ID = "d6b50ff0-e01d-4b84-b7ee-374d2e346611"
  const open = {
    status: "open",
    platformVersionId: VERSION_ID,
    release: { releaseId: RELEASE_ID, stateRevision: 206 },
  }

  function responses(bodies: Array<{ status: number; body: unknown }>) {
    let call = 0
    return () => {
      const next = bodies[Math.min(call, bodies.length - 1)]
      call += 1
      return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }))
    }
  }

  test("reports the state revision the deployment serves once the release is open", async () => {
    await expect(
      verifyOpenRelease({
        apiOrigin: "https://staging.test",
        releaseId: RELEASE_ID,
        platformVersionId: VERSION_ID,
        fetcher: (url) =>
          Promise.resolve(
            new Response(JSON.stringify(url.endsWith("/health") ? open : { signedAuth: true }), { status: 200 }),
          ),
        wait: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ stateRevision: 206 })
  })

  test("retries while the Worker still reports the phase the release replaced", async () => {
    let call = 0
    const result = await verifyOpenRelease({
      apiOrigin: "https://staging.test",
      releaseId: RELEASE_ID,
      platformVersionId: VERSION_ID,
      fetcher: (url) => {
        call += 1
        if (call === 1) return Promise.resolve(new Response(JSON.stringify({ status: "locked" }), { status: 200 }))
        return Promise.resolve(
          new Response(JSON.stringify(url.endsWith("/health") ? open : { signedAuth: true }), { status: 200 }),
        )
      },
      wait: () => Promise.resolve(),
    })

    expect(result).toEqual({ stateRevision: 206 })
  })

  test("gives up naming the release the deployment never reported open", async () => {
    await expect(
      verifyOpenRelease({
        apiOrigin: "https://staging.test",
        releaseId: RELEASE_ID,
        platformVersionId: VERSION_ID,
        attempts: 3,
        fetcher: responses([{ status: 503, body: { error: { code: "deployment_phase_denied" } } }]),
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow(RELEASE_ID)
  })

  test("refuses an open release whose signed-auth mode is off", async () => {
    await expect(
      verifyOpenRelease({
        apiOrigin: "https://staging.test",
        releaseId: RELEASE_ID,
        platformVersionId: VERSION_ID,
        attempts: 2,
        fetcher: (url) =>
          Promise.resolve(
            new Response(JSON.stringify(url.endsWith("/health") ? open : { signedAuth: false }), { status: 200 }),
          ),
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/signedAuth/)
  })

  test("refuses a deployment serving a different platform version", async () => {
    await expect(
      verifyOpenRelease({
        apiOrigin: "https://staging.test",
        releaseId: RELEASE_ID,
        platformVersionId: "11111111-2222-3333-4444-555555555555",
        attempts: 2,
        fetcher: () => Promise.resolve(new Response(JSON.stringify(open), { status: 200 })),
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/does not report/)
  })
})
