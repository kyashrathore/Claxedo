import { describe, expect, test } from "vitest"

import {
  betterAuthD1PreparationCommands,
  verifyBetterAuthD1ControlPlaneRecoveryOutput,
  verifyBetterAuthD1PreparationPrecondition,
  verifyBetterAuthD1PreparationOutput,
  verifyBetterAuthD1PreparationRollback,
  verifyBetterAuthD1PreparationSchema,
} from "./prepare-better-auth-d1"

const env = {
  CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
  CLAXEDO_PRODUCT_POSTURE: "user-deployed",
  CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
  CLAXEDO_DEPLOYMENT_ID: "deployment-test-01",
  CLAXEDO_RELEASE_SEQUENCE: "1",
  CLAXEDO_RELEASE_ID: "release-test-0001",
  CLAXEDO_WORKER_BUILD_ID: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  CLAXEDO_PLATFORM_VERSION_ID: "11111111-1111-1111-1111-111111111111",
  CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:0649de3450af10bc2af0e7f753ac375beb9bb87b4fa1ee8f0f8248825eb521e3",
  CLAXEDO_RECOVERY_EPOCH: `paired-d1-v1:sha256:${"1".repeat(64)}`,
  CLAXEDO_REQUEST_LIMITER_NAMESPACE_ID: "2101",
  BETTER_AUTH_URL: "https://api.claxedo.test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-long-enough",
  CLAXEDO_AUTH_INTROSPECTION_SECRET: "test-introspection-secret-that-is-long-enough",
  CLAXEDO_WRANGLER_CONFIG: "/tmp/selected-better-auth-d1.toml",
}

describe("Better Auth D1 remote preparation", () => {
  test("orders migration, canonical provisioning, and exact verification", async () => {
    const commands = await betterAuthD1PreparationCommands({
      env,
      staging: true,
      mode: "register-candidate",
      now: new Date("2026-08-28T00:00:00Z"),
    })
    expect(commands).toHaveLength(17)
    expect(commands[0]?.args).toEqual([
      "d1",
      "migrations",
      "apply",
      "AUTH_DB",
      "--remote",
      "--config",
      "/tmp/selected-better-auth-d1.toml",
    ])
    expect(commands[1]?.args).toEqual([
      "d1",
      "migrations",
      "apply",
      "CONTROL_PLANE_DB",
      "--remote",
      "--config",
      "/tmp/selected-better-auth-d1.toml",
    ])
    expect(commands[2]?.args.slice(0, 7)).toEqual([
      "d1",
      "execute",
      "AUTH_DB",
      "--remote",
      "--config",
      "/tmp/selected-better-auth-d1.toml",
      "--command",
    ])
    expect(commands[2]).toMatchObject({ verify: "schema" })
    expect(commands[3]).toMatchObject({ verify: "precondition" })
    const provisioning = commands.map((command) => command.args.at(-1) ?? "").join("\n")
    expect(provisioning).toContain(`'https://api.claxedo.test/control-plane'`)
    expect(provisioning).toContain(`'claxedo-cli'`)
    expect(provisioning).toContain(`'claxedo-desktop'`)
    expect(provisioning).toContain(`'claxedo-control-plane'`)
    expect(provisioning).toContain(`'deployment-test-01'`)
    expect(provisioning).toContain(`'browser-absent-v1'`)
    expect(provisioning).toContain(`'relay-absent-v1'`)
    expect(commands.at(-2)).toMatchObject({ verify: "candidate" })
    expect(commands.at(-1)).toMatchObject({ verify: "control-recovery" })
    expect(commands.at(-1)?.args[2]).toBe("CONTROL_PLANE_DB")
    for (const command of commands.filter((command) => command.args[1] === "execute").slice(0, -1)) {
      const sql = command.args[command.args.indexOf("--command") + 1] ?? ""
      expect(sql.split(";").filter((part) => part.trim())).toHaveLength(1)
    }
    expect(commands.flatMap((command) => command.args)).not.toContain("create")
  })

  test("rejects inferred, mixed, and incomplete profiles before any command", async () => {
    await expect(
      betterAuthD1PreparationCommands({
        env: { ...env, CLAXEDO_ADAPTER_PROFILE: undefined },
        staging: false,
        mode: "register-candidate",
      }),
    ).rejects.toThrow(/adapter profile must be/)
    await expect(
      betterAuthD1PreparationCommands({
        env: { ...env, CLAXEDO_PRODUCT_POSTURE: "claxedo-hosted" },
        staging: false,
        mode: "register-candidate",
      }),
    ).rejects.toThrow(/certifies only user-deployed/)
    await expect(
      betterAuthD1PreparationCommands({
        env: { ...env, BETTER_AUTH_URL: "http://api.claxedo.test" },
        staging: false,
        mode: "register-candidate",
      }),
    ).rejects.toThrow(/exact HTTPS API origin/)
  })

  test("accepts only the exact verified locked state and native-client closure", () => {
    const schema = JSON.stringify([
      {
        success: true,
        results: [
          {
            requiredIndexDefinitionCount: 25,
            requiredUniqueConstraintCount: 17,
            appendOnlyTriggerCount: 13,
            refreshAccessCascadeCount: 1,
            authenticationEvidenceForeignKeyCount: 2,
            cutoverReleaseForeignKeyCount: 4,
            recoveryReleaseForeignKeyCount: 2,
          },
        ],
      },
    ])
    expect(verifyBetterAuthD1PreparationSchema(schema)).toMatchObject({ requiredIndexDefinitionCount: 25 })
    expect(() =>
      verifyBetterAuthD1PreparationSchema(schema.replace('"appendOnlyTriggerCount":13', '"appendOnlyTriggerCount":12')),
    ).toThrow(/structural contract/)
    expect(
      verifyBetterAuthD1PreparationPrecondition(
        JSON.stringify([
          {
            success: true,
            results: [{ eligible: 1 }],
          },
        ]),
      ),
    ).toEqual({ eligible: 1 })
    expect(() =>
      verifyBetterAuthD1PreparationPrecondition(
        JSON.stringify([
          {
            success: true,
            results: [{ eligible: 0 }],
          },
        ]),
      ),
    ).toThrow(/stale or conflicting/)
    const valid = JSON.stringify([
      {
        success: true,
        results: [
          {
            phase: "locked",
            phaseRevision: 0,
            cliClient: 1,
            desktopClient: 1,
            introspectionClient: 1,
            resource: 1,
            resourceLinks: 3,
            authRecoveryEpoch: 1,
          },
        ],
      },
    ])
    expect(verifyBetterAuthD1PreparationOutput(valid)).toMatchObject({ phase: "locked" })
    expect(() => verifyBetterAuthD1PreparationOutput(valid.replace('"resourceLinks":3', '"resourceLinks":2'))).toThrow(
      /incomplete or non-locked/,
    )
    expect(() => verifyBetterAuthD1PreparationOutput("[]")).toThrow(/no result/)
    expect(
      verifyBetterAuthD1ControlPlaneRecoveryOutput(
        JSON.stringify([
          {
            success: true,
            results: [
              {
                deploymentId: env.CLAXEDO_DEPLOYMENT_ID,
                releaseId: env.CLAXEDO_RELEASE_ID,
                recoveryEpoch: env.CLAXEDO_RECOVERY_EPOCH,
              },
            ],
          },
        ]),
        {
          deploymentId: env.CLAXEDO_DEPLOYMENT_ID,
          releaseId: env.CLAXEDO_RELEASE_ID,
          recoveryEpoch: env.CLAXEDO_RECOVERY_EPOCH,
        },
      ),
    ).toMatchObject({ recoveryEpoch: env.CLAXEDO_RECOVERY_EPOCH })
  })

  test("requires a complete successor CAS contract", async () => {
    await expect(
      betterAuthD1PreparationCommands({
        env: { ...env, CLAXEDO_PREVIOUS_RELEASE_ID: "release-test-0000" },
        staging: false,
        mode: "register-candidate",
      }),
    ).rejects.toThrow(/inputs must be provided together/)
    const commands = await betterAuthD1PreparationCommands({
      env: {
        ...env,
        CLAXEDO_RELEASE_SEQUENCE: "2",
        CLAXEDO_RELEASE_ID: "release-test-0002",
        CLAXEDO_PREVIOUS_RELEASE_ID: "release-test-0001",
        CLAXEDO_PREVIOUS_STATE_REVISION: "0",
        CLAXEDO_PREVIOUS_PHASE: "locked",
        CLAXEDO_PREVIOUS_PHASE_REVISION: "0",
        CLAXEDO_RELEASE_OPERATION_ID: "operation-release-0002",
      },
      staging: false,
      mode: "register-candidate",
    })
    expect(commands.map((command) => command.args.join(" ")).join("\n")).toContain("locked_replacement")
  })

  test("keeps activation to one pointer mutation after rechecking the candidate", async () => {
    const commands = await betterAuthD1PreparationCommands({
      env,
      staging: false,
      mode: "activate-candidate",
      now: new Date("2026-08-28T00:01:00Z"),
    })
    expect(commands.map((command) => command.verify)).toEqual(["schema", "precondition", undefined, "final"])
    expect(commands[2]?.args.join(" ")).toContain(`insert into "deploymentReleaseActive"`)
    expect(commands.map((command) => command.args.join(" ")).join("\n")).not.toContain(
      `insert into "deploymentRelease" (`,
    )
  })

  test("renders an append-only predecessor rollback and verifies its new active revision", async () => {
    const successorEnv = {
      ...env,
      CLAXEDO_RELEASE_SEQUENCE: "2",
      CLAXEDO_RELEASE_ID: "release-test-0002",
      CLAXEDO_PREVIOUS_RELEASE_ID: "release-test-0001",
      CLAXEDO_PREVIOUS_STATE_REVISION: "0",
      CLAXEDO_PREVIOUS_PHASE: "locked",
      CLAXEDO_PREVIOUS_PHASE_REVISION: "0",
      CLAXEDO_RELEASE_OPERATION_ID: "operation-release-0002",
      CLAXEDO_ROLLBACK_OPERATION_ID: "operation-rollback-0002",
    }
    const commands = await betterAuthD1PreparationCommands({
      env: successorEnv,
      staging: false,
      mode: "rollback-candidate",
      now: new Date("2026-08-28T00:02:00Z"),
    })
    expect(commands.map((command) => command.verify)).toEqual([
      "schema",
      "precondition",
      undefined,
      undefined,
      "rollback",
    ])
    expect(commands.map((command) => command.args.join(" ")).join("\n")).toContain("prewrite_rollback")
    expect(
      verifyBetterAuthD1PreparationRollback(
        JSON.stringify([
          {
            success: true,
            results: [{ rolledBack: 1 }],
          },
        ]),
      ),
    ).toEqual({ rolledBack: 1 })
  })
})
