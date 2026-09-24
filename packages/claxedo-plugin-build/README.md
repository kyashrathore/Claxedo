# @claxedo/plugin-build

Turns a plugin package into one browser ES module. The daemon uses it for every registered folder; `claxedo plugin dev` and `claxedo plugin check` use it from the command line.

`buildPluginApp({ rootDir })` reads the `claxedo` manifest, compiles Solid JSX with `babel-preset-solid`, bundles with esbuild, and returns `{ manifest, code, hash, warnings }`. `hash` is the first 16 hex characters of the SHA-256 of `code`, so the same source always yields the same immutable URL.

The five host modules (`solid-js`, `solid-js/web`, `solid-js/store`, `@claxedo/plugin-api`, `@claxedo/app-v2/ui`) are not bundled. Each becomes a CommonJS shim that reads `globalThis.__claxedoPluginRuntime[specifier]`, which lets esbuild turn every named import into a property read with no export manifest to maintain. Every other dependency bundles from the plugin's own `node_modules`.

A failure is a `PluginBuildError` with `failure` (`manifest`, `entry`, `bundle`) and one message per problem. `watchPluginFolder` is the shared debounced watcher; it ignores `node_modules`, `dist` and `.git` and never keeps a process alive on its own.
