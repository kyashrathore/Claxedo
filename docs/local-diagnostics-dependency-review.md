# Local diagnostics dependency review

**Review date:** 2026-07-24  
**Scope:** process observation performed by the Claxedo desktop app on the user's machine

## Decision

Claxedo uses three exact-pinned npm packages behind `ProcessMetricsSource`:

| Package | Accepted use | Version | License | npm downloads, 2026-07-16 through 2026-07-22 |
| --- | --- | ---: | --- | ---: |
| [`pidusage`](https://github.com/soyuka/pidusage) | CPU and RSS for the registered PID set on Darwin and Linux | `4.0.1` | MIT | 3,957,653 |
| [`pidtree`](https://github.com/simonepri/pidtree) | Slow-cadence PID/PPID reconciliation on Darwin and Linux | `1.0.0` | MIT | 20,627,311 |
| [`@vscode/windows-process-tree`](https://github.com/microsoft/vscode-windows-process-tree) | PID/PPID ancestry on Windows, with process-data flags disabled | `0.8.0` | MIT | 104,445 |

The packages supply narrow observations. Claxedo owns process provenance, stable identity, retention, attribution, privacy filtering, source-health reporting, and authorization for user actions.

## Trust evidence

### Adoption and stewardship

- PM2's [current production manifest](https://github.com/Unitech/pm2/blob/master/package.json) exact-pins `pidusage@4.0.1`.
- VS Code's [current production manifest](https://github.com/microsoft/vscode/blob/main/package.json) depends on `@vscode/windows-process-tree@^0.8.0` and explicitly permits the package's native build.
- The upstream repositories are public, active, and MIT-licensed. At review time they were not archived: `pidusage` had 546 stars, `pidtree` had 126, and Microsoft's Windows addon had 92.
- `pidtree@1.0.0` is the current ESM/Node 18+ release. Its release commits are verified, its publish workflow uses npm trusted publishing, and its platform suite covers macOS, Ubuntu, and Windows.

The recorded adoption counts come from npm's public download endpoints for
[`pidusage`](https://api.npmjs.org/downloads/point/2026-07-16:2026-07-22/pidusage),
[`pidtree`](https://api.npmjs.org/downloads/point/2026-07-16:2026-07-22/pidtree), and
[`@vscode/windows-process-tree`](https://api.npmjs.org/downloads/point/2026-07-16:2026-07-22/%40vscode%2Fwindows-process-tree).

### Supply-chain controls

- `packages/claxedo-desktop/package.json` uses exact versions.
- `bun.lock` records the reviewed SHA-512 tarball integrity for every package.
- The two JavaScript packages have no dependency lifecycle scripts or native code.
- The Windows package is native and is the only diagnostics package admitted through the root `trustedDependencies` allowlist. Its published tarball contains `binding.gyp`; Bun's native build is expected and covered by the Windows packaged-app gate.
- The complete diagnostics closure adds only `safe-buffer@5.2.1` and `node-addon-api@7.1.0`. Both are exact-resolved, MIT-licensed, lifecycle-safe, and included in the integrity/advisory gate.
- Exact-version OSV queries returned no known advisories on the review date. CI repeats live OSV queries for all five packages.
- `verify:diagnostics-dependencies` fails when a version, license, integrity, lifecycle-script boundary, trusted-native declaration, or current advisory result changes.

The repository-wide `bun audit --production` is tracked separately from this
feature decision. On the review date it reported 143 existing advisories across
the wider monorepo and no path through the five-package diagnostics closure.
The diagnostics release gate therefore verifies its complete exact closure
directly instead of claiming that unrelated application dependencies are clean.

## Product boundaries

- Collection begins during Electron main startup and remains local to the desktop process.
- The adapters retain only the registered or reconciled owned process set. Environment variables, command lines, working directories, and arbitrary host-process rows do not cross the diagnostics contract.
- `pidusage` is configured as a known-PID sampler and its PID history is cleared when the profiler is disposed.
- `pidtree` output is filtered immediately to descendants of registered Claxedo roots and runs only for lifecycle reconciliation and slow recovery.
- The Windows addon receives `ProcessDataFlag.None`; its CPU and memory APIs are not used. A fixed CIM query supplies 64-bit CPU counters, RSS, and creation identity for the known PID set.
- Observation packages never grant Stop or Kill. A live owner operation, single-use grant, launch identity, and a fresh platform creation-identity check are all required.

## Release maintenance

A dependency update is accepted only after:

1. registry metadata, tarball contents, license, maintainers, integrity, lifecycle behavior, and current advisories are reviewed;
2. adapter semantics and privacy tests pass;
3. the real-child source smoke stays within the 1 percentage-point machine CPU and 20 MiB retention budgets; and
4. the packaged desktop smoke passes natively on every released OS and architecture.

Popularity and recognizable publishers support the decision; the exact pins, narrow adapters, independent identity proof, and release gates enforce it.
