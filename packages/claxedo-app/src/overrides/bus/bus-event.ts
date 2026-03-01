import type { ZodType } from "zod"

/**
 * Minimal re-implementation of opencode's BusEvent for the claxedo-app
 * typecheck scope. The real BusEvent lives in packages/opencode/src/bus/
 * and is used at runtime via the patched opencode binary. This override
 * only needs to satisfy the type-checker for files like process.ts that
 * are pulled into the claxedo-app include graph via UI component imports.
 */
export namespace BusEvent {
  export type Definition = ReturnType<typeof define>

  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    return {
      type,
      properties,
    }
  }
}
