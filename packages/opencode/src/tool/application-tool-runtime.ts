import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Effect, Exit, Scope } from "effect"
import { AppRuntime } from "@/effect/app-runtime"

export type ApplicationToolRegistration = Readonly<{
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execute(input: unknown, context: Tool.Context): Promise<unknown>
}>

/**
 * A tool input schema every provider will accept.
 *
 * Anthropic's tool `input_schema` must be a FLAT object schema: it requires a
 * top-level `type` and rejects `oneOf`/`anyOf`/`allOf` outright. Either fault
 * fails the whole request — `tools.37.custom.input_schema…` with no indication
 * of WHICH tool — so one malformed registrant breaks every turn in the session,
 * not just its own tool. That is what happened: `workgraph_ledger`'s schema
 * comes from a discriminated union, and `z.toJSONSchema` emits a bare `oneOf`.
 *
 * A union of object variants is flattened into one object: the union of all
 * properties, requiring only the fields EVERY variant requires. That is
 * deliberately permissive — the schema no longer expresses "these fields go
 * together" — but the tool's own parser still enforces the real contract
 * (`workgraph_ledger` re-parses with the union before executing), so the
 * validation moves rather than disappears, and the model still sees every field
 * and its description.
 *
 * Flattening beats rejecting the tool at registration: a rejected tool is a
 * silently missing capability, whereas this keeps it usable AND keeps the other
 * 64 tools' turns alive. The warning names the tool so the registrant can
 * express a flat schema at the source if it wants stricter provider-side
 * validation.
 */
export function providerSafeInputSchema(name: string, schema: Record<string, unknown>) {
  const variants = schema["oneOf"] ?? schema["anyOf"] ?? schema["allOf"]
  if (!Array.isArray(variants)) {
    if (typeof schema["type"] === "string") return schema
    return schema
  }
  const objects = variants.filter(
    (variant): variant is Record<string, unknown> =>
      !!variant && typeof variant === "object" && (variant as Record<string, unknown>)["type"] === "object",
  )
  // Only flatten when EVERY variant is an object — a union spanning kinds has
  // no faithful flat form, and inventing one would send a wrong schema rather
  // than a rejected one.
  if (objects.length === 0 || objects.length !== variants.length) return schema

  const properties: Record<string, unknown> = {}
  for (const variant of objects) {
    Object.assign(properties, (variant["properties"] as Record<string, unknown>) ?? {})
  }
  const requiredEverywhere = objects
    .map((variant) => new Set((variant["required"] as string[]) ?? []))
    .reduce((shared, next) => new Set([...shared].filter((key) => next.has(key))))

  console.warn(
    `[application-tools] "${name}" declared a oneOf/anyOf/allOf input schema; flattening to a single object. ` +
      `Anthropic rejects unions in tool input_schema and fails the ENTIRE request, breaking every tool in the session.`,
  )
  const { oneOf: _o, anyOf: _a, allOf: _l, ...rest } = schema
  return { ...rest, type: "object", properties, required: [...requiredEverywhere] }
}

/**
 * Promise boundary for an embedding host to register process-scoped Core tools.
 * The returned disposer removes exactly this registration.
 */
export async function register(tools: Readonly<Record<string, ApplicationToolRegistration>>) {
  const scope = await AppRuntime.runPromise(Scope.make())
  try {
    await AppRuntime.runPromise(
      ApplicationTools.Service.use((applications) =>
        applications
          .register(
            Object.fromEntries(
              Object.entries(tools).map(([name, registration]) => [
                name,
                Tool.makeDynamic({
                  description: registration.description,
                  inputSchema: providerSafeInputSchema(name, registration.inputSchema),
                  outputSchema: registration.outputSchema ?? {},
                  execute: (input, context) =>
                    Effect.tryPromise({
                      try: () => registration.execute(input, context),
                      catch: (error) =>
                        new Tool.Failure({
                          message: error instanceof Error ? error.message : String(error),
                        }),
                    }),
                }),
              ]),
            ),
          )
          .pipe(Scope.provide(scope)),
      ),
    )
  } catch (error) {
    await AppRuntime.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
  return () => AppRuntime.runPromise(Scope.close(scope, Exit.void))
}

export * as ApplicationToolRuntime from "./application-tool-runtime"
