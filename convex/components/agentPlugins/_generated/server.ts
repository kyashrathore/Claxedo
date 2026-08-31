/* eslint-disable */
/**
 * Component-local Convex function builders.
 *
 * Convex codegen normally emits this file. It is kept deliberately minimal so
 * the component can be tested before a deployment is configured; an enabled
 * deployment's `convex codegen` may replace it with the fully typed equivalent.
 */
export {
  mutationGeneric as mutation,
  queryGeneric as query,
} from "convex/server"
