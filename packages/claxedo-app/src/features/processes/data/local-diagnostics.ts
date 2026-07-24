import z from "zod"

/**
 * Data-only contract for diagnostics produced by the local desktop shell.
 *
 * Every object crossing the desktop boundary is strict. The contract exposes
 * safe display metadata and opaque action tokens, never process launch input.
 */
export namespace LocalDiagnostics {
  const Identifier = z.string().min(1).max(256)
  const Timestamp = z.number().int().nonnegative()
  const Duration = z.number().int().nonnegative()
  const SafeLabel = z.string().min(1).max(256)

  export const Domain = z.enum(["host", "wsl"])
  export type Domain = z.infer<typeof Domain>

  export const SourceId = z.enum([
    "electron",
    "owner-registry",
    "macos-ps",
    "linux-proc",
    "windows-process-tree",
    "windows-cim",
    "wsl",
    "direct-probe",
  ])
  export type SourceId = z.infer<typeof SourceId>

  export const UnavailableReason = z.enum([
    "warming-up",
    "unsupported",
    "permission-denied",
    "source-failed",
    "source-timeout",
    "source-truncated",
    "process-exited",
    "not-sampled",
    "identity-unavailable",
    "remote-excluded",
  ])
  export type UnavailableReason = z.infer<typeof UnavailableReason>

  const numericReading = (value: z.ZodNumber) =>
    z.discriminatedUnion("state", [
      z.object({ state: z.literal("available"), value }).strict(),
      z.object({ state: z.literal("unavailable"), reason: UnavailableReason }).strict(),
    ])

  export const CpuMachinePercent = numericReading(z.number().finite().min(0).max(100))
  export type CpuMachinePercent = z.infer<typeof CpuMachinePercent>

  export const ByteReading = numericReading(z.number().int().nonnegative())
  export type ByteReading = z.infer<typeof ByteReading>

  export const ByteChangeReading = numericReading(z.number().int())
  export type ByteChangeReading = z.infer<typeof ByteChangeReading>

  export const PercentReading = numericReading(z.number().finite().min(0).max(100))
  export type PercentReading = z.infer<typeof PercentReading>

  export const CreationIdentity = z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("available"),
        value: Identifier,
        source: SourceId,
      })
      .strict(),
    z
      .object({
        state: z.literal("unavailable"),
        reason: UnavailableReason,
      })
      .strict(),
  ])
  export type CreationIdentity = z.infer<typeof CreationIdentity>

  export const ProcessIdentity = z
    .object({
      id: Identifier,
      domain: Domain,
      pid: z.number().int().positive(),
      creation: CreationIdentity,
      launchId: Identifier.optional(),
    })
    .strict()
  export type ProcessIdentity = z.infer<typeof ProcessIdentity>

  export const OwnerKind = z.enum([
    "app",
    "electron-main",
    "renderer",
    "gpu",
    "utility",
    "server",
    "runtime",
    "sidecar",
    "pty",
    "managed-process",
    "session-shell",
    "mcp",
    "harness",
    "probe",
    "cli",
    "unmapped",
    "external",
  ])
  export type OwnerKind = z.infer<typeof OwnerKind>

  export const OwnerIdentity = z
    .object({
      id: Identifier,
      kind: OwnerKind,
      label: SafeLabel,
      launchId: Identifier.optional(),
      parentOwnerId: Identifier.optional(),
      access: z.enum(["local", "remote"]),
      lifecycle: z.enum(["current", "historical"]),
      workspaceId: Identifier.optional(),
      directory: z.string().min(1).max(4_096).optional(),
      harnessId: Identifier.optional(),
      sessionId: Identifier.optional(),
      attributionConfidence: z.enum(["direct", "inferred", "not-process-backed"]).optional(),
    })
    .strict()
  export type OwnerIdentity = z.infer<typeof OwnerIdentity>

  export const ActionKind = z.enum(["stop", "kill"])
  export type ActionKind = z.infer<typeof ActionKind>

  export const OpaqueActionToken = z.string().min(24).max(2_048)
  export type OpaqueActionToken = z.infer<typeof OpaqueActionToken>

  export const ActionGrant = z
    .object({
      action: ActionKind,
      token: OpaqueActionToken,
      expiresAt: Timestamp,
    })
    .strict()
  export type ActionGrant = z.infer<typeof ActionGrant>

  export const ActionIneligibilityReason = z.enum([
    "protected-process",
    "historical",
    "remote",
    "unregistered-owner",
    "owner-operation-unavailable",
    "identity-unavailable",
    "identity-mismatch",
    "detached",
  ])
  export type ActionIneligibilityReason = z.infer<typeof ActionIneligibilityReason>

  export const ActionEligibility = z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("eligible"),
        actions: ActionGrant.array().min(1),
      })
      .strict(),
    z
      .object({
        state: z.literal("ineligible"),
        reason: ActionIneligibilityReason,
      })
      .strict(),
  ])
  export type ActionEligibility = z.infer<typeof ActionEligibility>

  export const ProcessRole = z.enum([
    "main",
    "renderer",
    "gpu",
    "utility",
    "server",
    "runtime",
    "sidecar",
    "pty",
    "managed-process",
    "session-shell",
    "mcp",
    "harness",
    "probe",
    "cli",
    "descendant",
    "unmapped",
  ])
  export type ProcessRole = z.infer<typeof ProcessRole>

  export const ProcessRecord = z
    .object({
      identity: ProcessIdentity,
      parentProcessId: Identifier.optional(),
      ownerId: Identifier.optional(),
      role: ProcessRole,
      label: SafeLabel,
      lifecycle: z.enum(["starting", "running", "exited"]),
      actionEligibility: ActionEligibility,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.actionEligibility.state !== "eligible") return
      if (value.identity.creation.state === "available" && value.identity.launchId && value.ownerId) return
      context.addIssue({
        code: "custom",
        message: "Eligible actions require an owner, launch ID, and creation identity",
        path: ["actionEligibility"],
      })
    })
  export type ProcessRecord = z.infer<typeof ProcessRecord>

  export const MetricPoint = z
    .object({
      at: Timestamp,
      processId: Identifier,
      cpuMachinePercent: CpuMachinePercent,
      rssBytes: ByteReading,
    })
    .strict()
  export type MetricPoint = z.infer<typeof MetricPoint>

  export const SourceCapabilities = z
    .object({
      cpu: z.boolean(),
      rss: z.boolean(),
      ancestry: z.boolean(),
      creationIdentity: z.boolean(),
      actionIdentity: z.boolean(),
    })
    .strict()
  export type SourceCapabilities = z.infer<typeof SourceCapabilities>

  const SourceStatusBase = z.object({
    source: SourceId,
    domain: Domain,
    accuracy: z.enum(["native", "estimated", "unsupported"]),
    capabilities: SourceCapabilities,
  })

  export const SourceStatus = z.discriminatedUnion("state", [
    SourceStatusBase.extend({
      state: z.literal("warming-up"),
      lastSuccessAt: Timestamp.optional(),
    }).strict(),
    SourceStatusBase.extend({
      state: z.literal("healthy"),
      lastSuccessAt: Timestamp,
    }).strict(),
    SourceStatusBase.extend({
      state: z.literal("degraded"),
      reason: UnavailableReason,
      lastSuccessAt: Timestamp.optional(),
    }).strict(),
    SourceStatusBase.extend({
      state: z.literal("failed"),
      reason: UnavailableReason,
      lastSuccessAt: Timestamp.optional(),
    }).strict(),
    SourceStatusBase.extend({
      state: z.literal("unsupported"),
      reason: z.literal("unsupported"),
    }).strict(),
  ])
  export type SourceStatus = z.infer<typeof SourceStatus>

  export const LifecycleEvent = z.enum([
    "profiler-started",
    "source-degraded",
    "source-recovered",
    "process-appeared",
    "process-exited",
    "server-starting",
    "server-ready",
    "runtime-starting",
    "runtime-ready",
    "owner-started",
    "owner-exited",
    "action-requested",
    "action-completed",
    "action-failed",
    "app-shutdown",
  ])
  export type LifecycleEvent = z.infer<typeof LifecycleEvent>

  export const LifecycleMarker = z
    .object({
      type: z.literal("lifecycle"),
      id: Identifier,
      at: Timestamp,
      event: LifecycleEvent,
      ownerId: Identifier.optional(),
      processId: Identifier.optional(),
      source: SourceId.optional(),
      action: ActionKind.optional(),
      outcome: z.enum(["succeeded", "failed", "rejected"]).optional(),
    })
    .strict()
  export type LifecycleMarker = z.infer<typeof LifecycleMarker>

  export const ChurnMarker = z
    .object({
      type: z.literal("churn"),
      id: Identifier,
      at: Timestamp,
      ownerId: Identifier,
      launched: z.number().int().nonnegative(),
      exited: z.number().int().nonnegative(),
      shortestDurationMs: Duration.optional(),
      longestDurationMs: Duration.optional(),
      resourceMeasurement: z.discriminatedUnion("state", [
        z.object({ state: z.literal("measured") }).strict(),
        z
          .object({
            state: z.literal("unmeasured"),
            reason: UnavailableReason,
          })
          .strict(),
      ]),
    })
    .strict()
  export type ChurnMarker = z.infer<typeof ChurnMarker>

  export const Marker = z.discriminatedUnion("type", [LifecycleMarker, ChurnMarker])
  export type Marker = z.infer<typeof Marker>

  export const ChurnSummary = z
    .object({
      ownerId: Identifier,
      launched: z.number().int().nonnegative(),
      exited: z.number().int().nonnegative(),
      resourceMeasurement: z.enum(["measured", "unmeasured"]),
    })
    .strict()
  export type ChurnSummary = z.infer<typeof ChurnSummary>

  export const ContributorSummary = z
    .object({
      processId: Identifier.optional(),
      ownerId: Identifier.optional(),
      peakCpuMachinePercent: CpuMachinePercent,
      cpuSharePercent: PercentReading,
      peakRssBytes: ByteReading,
      rssChangeBytes: ByteChangeReading,
    })
    .strict()
    .refine((value) => value.processId !== undefined || value.ownerId !== undefined, {
      message: "A contributor must reference a process or owner",
    })
  export type ContributorSummary = z.infer<typeof ContributorSummary>

  export const MetricTotals = z
    .object({
      currentCpuMachinePercent: CpuMachinePercent,
      peakCpuMachinePercent: CpuMachinePercent,
      currentRssBytes: ByteReading,
      peakRssBytes: ByteReading,
      rssChangeBytes: ByteChangeReading,
    })
    .strict()
  export type MetricTotals = z.infer<typeof MetricTotals>

  export const IntervalSummary = z
    .object({
      startAt: Timestamp,
      endAt: Timestamp,
      sampleCount: z.number().int().nonnegative(),
      totals: MetricTotals,
      contributors: ContributorSummary.array(),
      churn: ChurnSummary.array(),
    })
    .strict()
    .refine((value) => value.startAt <= value.endAt, {
      message: "Interval start must not be after its end",
    })
  export type IntervalSummary = z.infer<typeof IntervalSummary>

  export const Retention = z.discriminatedUnion("state", [
    z.object({ state: z.literal("complete") }).strict(),
    z
      .object({
        state: z.literal("truncated"),
        reason: z.enum(["memory-pressure", "sample-limit"]),
      })
      .strict(),
  ])
  export type Retention = z.infer<typeof Retention>

  export const RetainedSnapshot = z
    .object({
      version: z.literal(1),
      generation: Identifier,
      capturedAt: Timestamp,
      retainedFromAt: Timestamp,
      targetWindowMs: Duration,
      retention: Retention,
      owners: OwnerIdentity.array(),
      processes: ProcessRecord.array(),
      samples: MetricPoint.array(),
      sources: SourceStatus.array(),
      markers: Marker.array(),
      interval: IntervalSummary,
    })
    .strict()
    .refine((value) => value.retainedFromAt <= value.capturedAt, {
      message: "Retained history cannot begin after capture",
    })
  export type RetainedSnapshot = z.infer<typeof RetainedSnapshot>

  export const SampleIdentity = z
    .object({
      at: Timestamp,
      processId: Identifier,
    })
    .strict()
  export type SampleIdentity = z.infer<typeof SampleIdentity>

  export const RetainedSnapshotDelta = z
    .object({
      version: z.literal(1),
      generation: Identifier,
      baseCapturedAt: Timestamp,
      capturedAt: Timestamp,
      retainedFromAt: Timestamp,
      targetWindowMs: Duration,
      retention: Retention,
      owners: OwnerIdentity.array(),
      processes: ProcessRecord.array(),
      sources: SourceStatus.array(),
      interval: IntervalSummary,
      sampleUpserts: MetricPoint.array(),
      sampleRemovals: SampleIdentity.array(),
      markerUpserts: Marker.array(),
      markerRemovals: Identifier.array(),
    })
    .strict()
  export type RetainedSnapshotDelta = z.infer<typeof RetainedSnapshotDelta>

  export const SnapshotUpdate = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("full"), snapshot: RetainedSnapshot }).strict(),
    z.object({ kind: z.literal("delta"), delta: RetainedSnapshotDelta }).strict(),
  ])
  export type SnapshotUpdate = z.infer<typeof SnapshotUpdate>

  export const StopRequest = z
    .object({
      action: z.literal("stop"),
      token: OpaqueActionToken,
    })
    .strict()
  export type StopRequest = z.infer<typeof StopRequest>

  export const KillRequest = z
    .object({
      action: z.literal("kill"),
      token: OpaqueActionToken,
    })
    .strict()
  export type KillRequest = z.infer<typeof KillRequest>

  export const ActionRequest = z.discriminatedUnion("action", [StopRequest, KillRequest])
  export type ActionRequest = z.infer<typeof ActionRequest>

  export const ActionResult = z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        action: ActionKind,
        completedAt: Timestamp,
        markerId: Identifier,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        action: ActionKind,
        code: z.enum([
          "invalid-token",
          "expired-token",
          "stale-generation",
          "identity-mismatch",
          "owner-unavailable",
          "not-eligible",
          "user-cancelled",
          "operation-failed",
          "already-exited",
        ]),
      })
      .strict(),
  ])
  export type ActionResult = z.infer<typeof ActionResult>

  export type Capability = {
    getSnapshot(): Promise<RetainedSnapshot>
    subscribe(listener: (snapshot: RetainedSnapshot) => void): () => void
    stop(request: StopRequest): Promise<ActionResult>
    kill(request: KillRequest): Promise<ActionResult>
  }
}
