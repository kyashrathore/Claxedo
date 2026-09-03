import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import Database from "better-sqlite3"

import { GREENFIELD_AUTH_TABLE_COUNTS, GREENFIELD_CONTROL_PLANE_TABLE_COUNTS } from "./prove-greenfield-target-absence"
import {
  betterAuthD1ReleaseInputs,
  renderBetterAuthD1WranglerConfig,
  type BetterAuthD1ReleaseEnvironment,
} from "./release-better-auth-d1"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const FORBIDDEN_EXPORT_SQL = /\b(?:attach|detach|load_extension)\b|\bvacuum\s+into\b|\bpragma\s+writable_schema\b/i
const CREATE_TRIGGER_SQL = /^CREATE TRIGGER\b[\s\S]*?\bEND;\s*$/gim
const CREATE_TRIGGER_START = /^CREATE TRIGGER\b/gim

type Binding = Readonly<{ deploymentId: string; releaseId: string; recoveryEpoch: string }>

export type PairedD1BackupEvidence = Readonly<{
  schemaVersion: 1
  deploymentId: string
  releaseId: string
  recoveryEpoch: string
  authBackupSha256: string
  controlPlaneBackupSha256: string
  databases: readonly Readonly<{
    binding: "AUTH_DB" | "CONTROL_PLANE_DB"
    databaseId: string
    integrity: "ok"
    tables: readonly Readonly<{ table: string; rows: number }>[]
  }>[]
}>

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for paired D1 backup verification`)
  return value
}

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function dependencyOrderedExport(sql: string) {
  const triggerCount = sql.match(CREATE_TRIGGER_START)?.length ?? 0
  const triggers = sql.match(CREATE_TRIGGER_SQL) ?? []
  if (triggers.length !== triggerCount) {
    throw new Error(`SQLite export contained ${triggerCount} triggers but only ${triggers.length} complete trigger blocks`)
  }
  const deferred = triggers.filter((trigger) => /\bINSTEAD\s+OF\b/i.test(trigger))
  if (deferred.length === 0) return sql
  return `${sql.replace(CREATE_TRIGGER_SQL, (trigger) => (/\bINSTEAD\s+OF\b/i.test(trigger) ? "" : trigger))}\n${deferred.join("\n")}\n`
}

function restoreExport(input: {
  label: "AUTH_DB" | "CONTROL_PLANE_DB"
  sql: string
  expectedTables: Readonly<Record<string, number>>
  binding: Binding
}) {
  if (!input.sql.trim() || FORBIDDEN_EXPORT_SQL.test(input.sql)) {
    throw new Error(`${input.label} backup is empty or contains unsafe SQLite export commands`)
  }
  const database = new Database(":memory:")
  try {
    // D1 exports schema objects alphabetically, so an INSTEAD OF trigger can
    // precede the view it targets. Replay the original bytes in dependency-safe
    // order without changing the immutable backup artifact or its digest.
    database.pragma("foreign_keys = OFF")
    database.exec(dependencyOrderedExport(input.sql))
    const foreignKeyFailures = database.pragma("foreign_key_check") as unknown[]
    if (foreignKeyFailures.length !== 0) throw new Error(`${input.label} restored foreign-key check failed`)
    database.pragma("foreign_keys = ON")
    const integrity = database.pragma("integrity_check", { simple: true })
    if (integrity !== "ok") throw new Error(`${input.label} restored integrity check failed`)
    const schemaTables = database
      .prepare(
        `select name from sqlite_schema where type = 'table'
          and name not like 'sqlite\\_%' escape '\\'
          and name not like '\\_cf\\_%' escape '\\'
          and name <> 'd1_migrations' order by name`,
      )
      .all() as Array<{ name: string }>
    const expectedNames = Object.keys(input.expectedTables).sort()
    const actualNames = schemaTables.map((row) => row.name)
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      const missing = expectedNames.filter((name) => !actualNames.includes(name))
      const unexpected = actualNames.filter((name) => !expectedNames.includes(name))
      throw new Error(
        `${input.label} restored schema drifted (missing: ${missing.join(",") || "none"}; unexpected: ${unexpected.join(",") || "none"})`,
      )
    }
    const recovery =
      input.label === "AUTH_DB"
        ? (database
            .prepare(
              `select "deploymentId" as deploymentId, "releaseId" as releaseId, "recoveryEpoch" as recoveryEpoch
               from "deploymentRecoveryEpoch" where "deploymentId" = ? and "releaseId" = ?`,
            )
            .get(input.binding.deploymentId, input.binding.releaseId) as Binding | undefined)
        : (database
            .prepare(
              `select deployment_id as deploymentId, release_id as releaseId, recovery_epoch as recoveryEpoch
               from control_plane_recovery_epochs where deployment_id = ? and release_id = ?`,
            )
            .get(input.binding.deploymentId, input.binding.releaseId) as Binding | undefined)
    if (
      recovery?.deploymentId !== input.binding.deploymentId ||
      recovery.releaseId !== input.binding.releaseId ||
      recovery.recoveryEpoch !== input.binding.recoveryEpoch
    ) {
      throw new Error(`${input.label} restored recovery epoch does not match the active pair`)
    }
    if (input.label === "AUTH_DB") {
      const active = database
        .prepare(
          `select state.phase, state."phaseRevision" as phaseRevision, state."firstTargetWriteAt" as firstTargetWriteAt
           from "deploymentReleaseActive" active
           join "deploymentReleaseStateHistory" state
             on state."deploymentId" = active."deploymentId" and state."stateRevision" = active."stateRevision"
           where active.singleton = 1 and active."deploymentId" = ? and state."releaseId" = ?`,
        )
        .get(input.binding.deploymentId, input.binding.releaseId) as
        { phase?: unknown; phaseRevision?: unknown; firstTargetWriteAt?: unknown } | undefined
      if (
        active?.phase !== "provider_sync" ||
        !Number.isSafeInteger(active.phaseRevision) ||
        (active.phaseRevision as number) < 1 ||
        typeof active.firstTargetWriteAt !== "string" ||
        !active.firstTargetWriteAt
      ) {
        throw new Error("AUTH_DB backup was not captured from the admitted provider_sync release")
      }
    }
    const tables = Object.freeze(
      expectedNames.map((table) => {
        const escaped = table.replaceAll('"', '""')
        const row = database.prepare(`select count(*) as rows from "${escaped}"`).get() as { rows: number }
        return Object.freeze({ table, rows: row.rows })
      }),
    )
    return Object.freeze({ integrity: "ok" as const, tables })
  } finally {
    database.close()
  }
}

export function verifyPairedD1BackupExports(input: {
  authSql: Uint8Array
  controlPlaneSql: Uint8Array
  authDatabaseId: string
  controlPlaneDatabaseId: string
  binding: Binding
}): PairedD1BackupEvidence {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const auth = restoreExport({
    label: "AUTH_DB",
    sql: decoder.decode(input.authSql),
    expectedTables: GREENFIELD_AUTH_TABLE_COUNTS,
    binding: input.binding,
  })
  const controlPlane = restoreExport({
    label: "CONTROL_PLANE_DB",
    sql: decoder.decode(input.controlPlaneSql),
    expectedTables: GREENFIELD_CONTROL_PLANE_TABLE_COUNTS,
    binding: input.binding,
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    ...input.binding,
    authBackupSha256: digest(input.authSql),
    controlPlaneBackupSha256: digest(input.controlPlaneSql),
    databases: Object.freeze([
      Object.freeze({ binding: "AUTH_DB" as const, databaseId: input.authDatabaseId, ...auth }),
      Object.freeze({
        binding: "CONTROL_PLANE_DB" as const,
        databaseId: input.controlPlaneDatabaseId,
        ...controlPlane,
      }),
    ]),
  })
}

async function runWrangler(args: readonly string[]) {
  const executable = path.join(
    serverRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  )
  const child = spawn(executable, args, {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed`)
}

async function main() {
  const environment: BetterAuthD1ReleaseEnvironment = process.argv.includes("--staging") ? "staging" : "production"
  const release = betterAuthD1ReleaseInputs(process.env, environment)
  const deploymentId =
    release.runtimeVariables.find(([name]) => name === "CLAXEDO_DEPLOYMENT_ID")?.[1] ??
    required(process.env, `CLAXEDO_${environment.toUpperCase()}_DEPLOYMENT_ID`)
  const recoveryEpoch =
    release.runtimeVariables.find(([name]) => name === "CLAXEDO_RECOVERY_EPOCH")?.[1] ??
    required(process.env, "CLAXEDO_RECOVERY_EPOCH")
  const outputDirectory = path.resolve(
    process.env.CLAXEDO_PAIRED_D1_BACKUP_DIRECTORY?.trim() ??
      path.join(serverRoot, ".artifacts", "paired-d1-backups", required(process.env, "CLAXEDO_RELEASE_ID")),
  )
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await chmod(outputDirectory, 0o700)
  const authPath = path.join(outputDirectory, "auth-db.sql")
  const controlPath = path.join(outputDirectory, "control-plane-db.sql")
  if (process.argv.includes("--export-and-verify")) {
    for (const output of [authPath, controlPath]) {
      if (
        await stat(output).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error(`paired D1 export refuses to overwrite existing artifact ${output}`)
      }
    }
    const temporary = await mkdtemp(path.join(serverRoot, ".claxedo-paired-backup-"))
    try {
      const config = path.join(temporary, "wrangler.toml")
      await writeFile(config, renderBetterAuthD1WranglerConfig({ staging: environment === "staging", ...release }))
      for (const [binding, output] of [
        ["AUTH_DB", authPath],
        ["CONTROL_PLANE_DB", controlPath],
      ] as const) {
        await runWrangler(["d1", "export", binding, "--remote", "--config", config, "--output", output])
        await chmod(output, 0o600)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  } else if (!process.argv.includes("--verify")) {
    throw new Error("select --export-and-verify or --verify")
  }
  const evidence = verifyPairedD1BackupExports({
    authSql: await readFile(authPath),
    controlPlaneSql: await readFile(controlPath),
    authDatabaseId: release.authDatabaseId,
    controlPlaneDatabaseId: release.controlPlaneDatabaseId,
    binding: { deploymentId, releaseId: required(process.env, "CLAXEDO_RELEASE_ID"), recoveryEpoch },
  })
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
