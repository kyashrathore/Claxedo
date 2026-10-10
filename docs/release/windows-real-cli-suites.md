# Windows real-CLI suites before a release

Windows CI (`.github/workflows/test.yml`) sets `CLAXEDO_REAL_CLI_SUITES=skip`, which leaves out the suites that start real Codex, Claude Code and OpenCode processes:

- `packages/harness/src/conformance/**`
- `packages/claxedo-local-server/src/**/*.live.test.ts`

On GitHub's hosted 4-vCPU Windows runner they run about five times slower than on 8 cores and miss their budgets. Linux CI runs them on every push. Before cutting a release, run them on an 8-core Windows box from a checkout of the release commit:

```sh
caffeinate -i ./script/cbx run --provider aws --target windows --arch amd64 --type m7i.2xlarge --market on-demand -- \
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File script/cbx-ci-windows.ps1 \
  -Lane package-test -Package "@claxedo/harness,@claxedo/local-server" -BuildPackages -Continue
```

The release is ready for Windows when both packages report `0 fail`. Harness takes about 21 minutes there, local-server about 7.
