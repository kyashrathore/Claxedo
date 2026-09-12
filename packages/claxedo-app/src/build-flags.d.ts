/**
 * Build-time feature selection, replaced by each product's bundler `define`
 * before Rollup links the graph.
 *
 * A bare identifier, not `import.meta.env.X`: the latter survives as a
 * property access, so the guarded branch — and the chunk behind the dynamic
 * import inside it — stays in the artifact. Folding to a literal is what makes
 * the feature absent rather than merely unreachable.
 *
 * `CLAXEDO_BUILD_TASKS=0` is the only value that turns Tasks off. An unset
 * variable keeps it, so a build that forgets to pass it ships the feature
 * instead of silently dropping it.
 */
declare const __CLAXEDO_TASKS_ENABLED__: boolean
