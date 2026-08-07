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

/** Application-tool producers own the provider-facing schema they register. */
export function requireProviderInputSchema(name: string, schema: Record<string, unknown>) {
  if (schema.type !== "object") {
    throw new Error(`Application tool "${name}" inputSchema must declare top-level type "object"`)
  }
  const union = ["oneOf", "anyOf", "allOf"].find((keyword) => keyword in schema)
  if (union) {
    throw new Error(`Application tool "${name}" inputSchema cannot declare top-level ${union}`)
  }
  return schema
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
                  inputSchema: requireProviderInputSchema(name, registration.inputSchema),
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
