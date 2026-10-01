# Process ownership

`@claxedo/process-ownership` owns process creation identity, the launch gate, identity-checked retirement, process lifecycle, Windows command resolution, and harness spawn environments.

Import the needed surface directly from `@claxedo/process-ownership/launch`, `/process-lifecycle`, `/windows-process`, or `/spawn-env`. Hosts copy `dist/launch-gate-child.mjs` as a standalone file beside their bundle.
