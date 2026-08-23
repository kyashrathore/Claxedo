#!/usr/bin/env bash
# Sync + install + build everything the unit / e2e / perf runs need on a box.
# Mirrors .github/workflows/test.yml's setup steps.
#
#   script/cbx-prepare.sh cbx1 cbx2 cbx3 cbx4
set -uo pipefail
cd "$(dirname "$0")/.."

BOXES=("$@")
[ ${#BOXES[@]} -eq 0 ] && { echo "usage: $0 <box-slug>..." >&2; exit 2; }

OUT=${PREPARE_OUT_DIR:-/tmp/cbx-prepare}
mkdir -p "$OUT"

for box in "${BOXES[@]}"; do
  (
    ./script/cbx run --id "$box" --reclaim -- bash -c 'umask 022; set -e
      # ---- 1. DEPENDENCIES ----------------------------------------------------
      # Install before creating the synthetic repository below. Dependency
      # patches target ignored node_modules trees; inside a shallow/synthetic
      # repository, git apply may try to resolve their patch index object IDs
      # from that repository and fail because those package blobs are not part
      # of its object database. Outside a repository, the patch runner uses its
      # intended cwd-relative mode and verifies the installed files directly.
      bun install --frozen-lockfile
      # The perf harness is a nested, independently locked package; the root
      # `packages/*` workspace install does not own its dependencies.
      (cd packages/claxedo-app/perf-harness && bun install --frozen-lockfile)

      # ---- 2. A REAL GIT REPOSITORY AT THE WORKDIR ----------------------------
      # crabbox syncs FILES, not the repository: the box workdir has no `.git`
      # at all. CI never notices because actions/checkout leaves one. Two lanes
      # do notice, because they shell out to git against the repo root:
      #   @workgraph-real -> claxedo-server/src/hosts/workgraph/local/execution.ts
      #     runs `git -C <repo> rev-parse --show-toplevel` and then
      #     `git worktree add --detach <dir> HEAD` to provision every Stream
      #     envelope. Without a repo, every Stream parks immediately with
      #     `fatal: not a git repository (or any of the parent directories)`.
      # `git init` + one commit here, rather than shipping the real `.git`:
      #   * The local checkout is a git WORKTREE (.claude/worktrees/<name>), so
      #     its `.git` is a FILE holding `gitdir: /Users/...` — an absolute path
      #     into the main clone. Copied to a box it is a dangling pointer, so
      #     "rsync the real .git" does not even work in the shape it is
      #     available in; it would first have to be materialised into a real
      #     directory.
      #   * The full object store is GBs on every prepare, over the wire, to
      #     satisfy exactly two git calls.
      #   * Neither lane reads history. `baseRevisions` are supplied by the e2e
      #     fixture (`real-workgraph-harness.ts` -> ["HEAD", "dev"]) and every
      #     spec fills "HEAD"; Tier R makes its own scratch repos with
      #     `git init` already (`makeWorkspace`). A single commit whose tree IS
      #     the synced working tree is therefore a truer fixture than real
      #     history: `rev-parse --show-toplevel` resolves to the workdir and
      #     `worktree add --detach <dir> HEAD` checks out exactly the code under
      #     test.
      # Branch `dev` because packages/script reads `git branch --show-current`
      # as the opencode release channel when OPENCODE_CHANNEL is unset.
      # Identity is repo-local (linked worktrees share this config file), not
      # `-c` flags, so anything the product itself commits also has an author.
      if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
        git init -q -b dev .
        git config user.email e2e@claxedo.test
        git config user.name "crabbox prepare"
        git config commit.gpgsign false
        git add -A
        git commit -q -m "crabbox prepare snapshot"
      fi
      git rev-parse --show-toplevel

      # ---- 3. HARNESS CLIs ----------------------------------------------------
      # Tier R (@tier-real) spawns the real `claude` and `codex` binaries; the
      # workflow installs them in its own step. Absent, `requireBinary` throws
      # `GATING:` under CI=1 and the claude/codex scenarios die there, so the
      # lane can never report on the harnesses it exists to cover. NO
      # CREDENTIALS are involved: the scripted model server is the endpoint, so
      # these CLIs are installed and never authenticate.
      # `npm config get prefix` is /usr on this image and /usr/lib/node_modules
      # is root-owned, so the install needs sudo; the resulting bins land in
      # /usr/bin, already on the non-interactive PATH the lane runs under.
      if ! command -v claude >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
        sudo -n env "PATH=$PATH" npm install -g --no-fund --no-audit @anthropic-ai/claude-code @openai/codex
      fi
      claude --version
      codex --version

      # ---- 4. DIST-RESOLVED WORKSPACE PACKAGES --------------------------------
      bun turbo build \
        --filter=@claxedo/agent-event-runtime \
        --filter=@claxedo/agent-extensions \
        --filter=@claxedo/agent-sdk-runtime \
        --filter=@claxedo/channels \
        --filter=@claxedo/connections \
        --filter=@claxedo/mcp \
        --filter=@claxedo/sandbox-manager \
        --filter=@claxedo/wakes \
        --filter=@claxedo/workgraph \
        --filter=@claxedo/workspace-relay-protocol \
        --filter=@claxedo/workspace-relay \
        --filter=@claxedo/workspace-runtime
      (cd packages/claxedo-local-server && bun run build)

      # ---- 5. OPENCODE CLI + EMBEDDED ENGINE ----------------------------------
      # A separate Tier-R process-lifecycle spec launches the real
      # `opencode serve` command through workspace-runtime. A workspace install
      # does not expose this private package as a root node_modules/.bin entry,
      # so build the current-platform CLI and install that exact repository
      # binary on PATH. The build clears dist/, therefore build the node embed
      # immediately afterwards.
      (cd packages/opencode && \
        OPENCODE_CHANNEL=selfhost OPENCODE_VERSION=0.0.0-selfhost \
        bun run build --single --skip-install)
      sudo -n install -m 0755 packages/opencode/dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
      opencode --version

      # `packages/opencode/dist/node/node.js` is a BUILT, gitignored artifact
      # that no `--filter` above produces (turbo.json deliberately keeps
      # `opencode#build` out of the generic graph). claxedo-server loads it via
      # `opencode/node-embed` -> packages/claxedo-server-core/node_modules/
      # opencode (a symlink to packages/opencode), so without it Tier R boots a
      # server whose engine surface never comes up and every scenario fails with
      # "The SDK-next embedded OpenCode engine failed to load."
      # `build:node`, never bare `build`: the full target deletes dist/node and
      # strips node-pty from package.json as a side effect.
      # The channel/version pins mirror packages/claxedo-server/Dockerfile: they
      # make the build hermetic, since @opencode-ai/script otherwise derives the
      # channel from `git branch --show-current` and the version from a live
      # registry.npmjs.org fetch. Both defines are inert in the node bundle.
      (cd packages/opencode && OPENCODE_CHANNEL=selfhost OPENCODE_VERSION=0.0.0-selfhost bun run build:node)
      test -s packages/claxedo-server-core/node_modules/opencode/dist/node/node.js

      # ---- 6. PLAYWRIGHT BROWSERS ---------------------------------------------
      # Browsers come from the base image; only install when they are actually
      # missing. Re-running the installer OVER a populated cache has produced a
      # ZERO-BYTE chrome-headless-shell -- the file is there and executable, it
      # launches and exits 0 with no output, and Playwright reports "Target
      # page, context or browser has been closed" for every test with nothing
      # in any log naming the browser cache. A clean install into an empty
      # cache is reliable, so wipe before installing, and use the pinned
      # playwright from node_modules rather than npx (the npx->bunx shim
      # resolves playwright@latest, a different version than the suite imports).
      cd packages/claxedo-app
      CHROME=$(find ~/.cache/ms-playwright -name chrome-headless-shell -type f 2>/dev/null | head -1)
      if [ -z "$CHROME" ] || [ ! -s "$CHROME" ]; then
        rm -rf ~/.cache/ms-playwright
        ./node_modules/.bin/playwright install chromium
        CHROME=$(find ~/.cache/ms-playwright -name chrome-headless-shell -type f | head -1)
      fi
      # Run it. Stat-ing the path did not catch the zero-byte binary; this does.
      [ -n "$CHROME" ] && [ -s "$CHROME" ] && "$CHROME" --version
      echo prepared-ok' > "$OUT/$box.log" 2>&1
    echo "$box exited $?"
  ) &
done
wait

echo
echo "================ PREPARE RESULTS ================"
for box in "${BOXES[@]}"; do
  printf '%-8s %s\n' "$box" "$(grep -c prepared-ok "$OUT/$box.log" >/dev/null && tail -1 "$OUT/$box.log")"
done
echo "logs in $OUT"
