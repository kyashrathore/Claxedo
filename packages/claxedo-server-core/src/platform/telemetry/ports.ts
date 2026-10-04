/**
 * Telemetry contracts the platform layer defines and domains implement.
 *
 * These live here rather than in `authority/services.ts` because platform code
 * (`platform/auth/worker-telemetry.ts`, `platform/telemetry/product/product.ts`)
 * needs them, and platform must not import a domain. `services.ts` is the
 * composition bag — it names every domain it wires together, so a platform file
 * importing a type from it drags the whole graph across the boundary.
 *
 * Structural by design: any object with a matching `capture` satisfies this,
 * including a test spy.
 */
export type ControlPlaneTelemetry = {
  capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void
}
