# @claxedo/plugin-build

Turns an app plugin package into one browser ES module, and checks one before it is registered. The daemon uses it for every registered folder and behind the Claxedo MCP tools `app_plugin_check` and `app_plugin_add`.

`buildPluginApp({ rootDir })` reads the `claxedo` manifest, compiles Solid JSX with `babel-preset-solid`, bundles with esbuild, and returns `{ manifest, code, hash, warnings }`. `hash` is the first 16 hex characters of the SHA-256 of the manifest and `code`, so the same source always yields the same immutable URL.

The five host modules (`solid-js`, `solid-js/web`, `solid-js/store`, `@claxedo/plugin-api`, `@claxedo/app/ui`) are not bundled. Each becomes a CommonJS shim that reads `globalThis.__claxedoPluginRuntime[specifier]`, which lets esbuild turn every named import into a property read with no export manifest to maintain. Every other dependency bundles from the plugin's own `node_modules`.

`./app-bundle-cli` is the same build as a command: `bun app-bundle-cli.ts <plugin folder>` prints `{ manifest, hash, code }` as JSON. The app's Vite plugin (`packages/claxedo-app/vite.plugin-bundles.ts`) spawns it to bundle the first-party plugins, because Vite's config loader cannot import this package's TypeScript source. It is exported under the `development` condition only, so the desktop's staged toolchain, which ships the `default` exports, leaves it out.

`buildPluginBackend({ rootDir })` bundles `claxedo.backend.entry` into the one ES module the hosted Worker loads, with only `cloudflare:*` left external, and returns `{ manifest, code }`. It refuses a bundle that does not export `default` and every class `claxedo.backend.objects` names.

`buildPluginRelease({ rootDir, storage?, builtAt? })` builds the app bundle (minified) and, when the manifest declares one, the backend, and returns `{ release, blobs }`: an unsigned `PluginRelease` (`@claxedo/plugin-api/release`) whose bundles are named by their full SHA-256 and byte size, and each bundle's code by that hash. `storage` defaults to 1. `signPluginRelease(release, privateKey, keyId)` signs it with an Ed25519 key. `./release-cli` does both and writes a registry tree: `CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY=<base64 PKCS#8> CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID=<id> bun release-cli.ts <plugin folder> <registry folder>` writes `releases/<id>/<version>.json` and `blobs/<sha256>`.

`checkPluginApp({ rootDir })` reads the manifest, typechecks the folder, then builds the app and, when the manifest declares one, the backend, and answers `{ ok, manifest?, hash?, diagnostics }`. The typecheck runs this package's TypeScript compiler over a config written to a temporary folder, so the plugin needs no `node_modules`, `tsconfig.json` or install step, and nothing is written into it:

- `@claxedo/plugin-api` and Solid resolve to the copies this package depends on, so a plugin is checked against the API the daemon serves.
- `@claxedo/app/ui` and `cloudflare:workers` are declared untyped: neither has a type contract this package ships, so their imports typecheck as `any` and only the build proves they exist.
- Diagnostics in files outside the plugin folder are dropped; they are the host's, not the plugin's.

A diagnostic is `{ stage, file?, line?, column?, code?, message }`, with `stage` one of `manifest`, `entry`, `typecheck` or `bundle` and `file` relative to the plugin folder. A build failure is a `PluginBuildError` carrying the same diagnostics, plus `messages` formatted as `file:line:column: message` for the daemon's `lastError`. `watchPluginFolder` is the shared debounced watcher; it ignores `node_modules`, `dist` and `.git` and never keeps a process alive on its own.
