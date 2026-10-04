#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: check-boat-sandbox-policy.sh IMAGE}
case "$image" in
  ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-*) ;;
  *) echo 'Expected an immutable Claxedo runtime image' >&2; exit 2 ;;
esac
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
policy="$root/src/drivers/boat-security"
apparmor=()
apparmor_source=$(mktemp)
env_dir=$(mktemp -d)
trap 'rm -f "$apparmor_source"; sudo rm -rf -- "$env_dir"' EXIT
printf 'export CLAXEDO_ENV_PROBE=delivered\n' > "$env_dir/upload"
chmod 600 "$env_dir/upload"
sudo chown 1001:1001 "$env_dir/upload"
sudo install -m 600 -o 0 -g 0 "$env_dir/upload" "$env_dir/runtime"
python3 -c 'import json,sys; sys.stdout.write("\n".join(json.load(open(sys.argv[1]))))' \
  "$policy/apparmor.json" > "$apparmor_source"
if docker info --format '{{json .SecurityOptions}}' | grep -Fq 'name=apparmor'; then
  sudo apparmor_parser -r -W "$apparmor_source"
  sudo grep -Fxq 'claxedo-workspace-runtime (enforce)' /sys/kernel/security/apparmor/profiles
  apparmor=(--security-opt apparmor=claxedo-workspace-runtime)
fi

docker run --rm --init --cap-drop ALL --cap-add SETFCAP --cap-add CHOWN --security-opt no-new-privileges \
  --security-opt "seccomp=$policy/seccomp.json" "${apparmor[@]}" \
  -v "$env_dir/upload:/run/boat-upload.env:ro" -v "$env_dir/runtime:/run/claxedo-runtime.env:ro" \
  --entrypoint sh "$image" -lc '
    set -eu
    if ( . /run/boat-upload.env ); then
      echo "Unexpected access to another user private environment" >&2
      exit 1
    fi
    . /run/claxedo-runtime.env
    test "$CLAXEDO_ENV_PROBE" = delivered
    test "$(stat -c %u:%g:%a /run/claxedo-runtime.env)" = 0:0:600
    grep -Eq "^CapEff:[[:space:]]+0000000080000001$" /proc/self/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status
    unshare -Ur true
    if unshare -m true; then
      echo "Unexpected mount namespace authority outside a user namespace" >&2
      exit 1
    fi
    mkdir -p /workspace /root/.codex-policy-home
    chown 1000:1000 /workspace
    chown "$(id -u):$(id -g)" /workspace
    test "$(stat -c %u:%g /workspace)" = "$(id -u):$(id -g)"
    export CODEX_HOME=/root/.codex-policy-home
    codex sandbox -P :workspace -C /workspace -- sh -lc '\''
      set -eu
      printf native-sandbox-ok > /workspace/native-sandbox-probe.txt
      if printf forbidden > /etc/claxedo-policy-must-not-exist; then
        echo "Codex wrote outside the workspace" >&2
        exit 1
      fi
      test "$(cat /workspace/native-sandbox-probe.txt)" = native-sandbox-ok
    '\''
    test ! -e /etc/claxedo-policy-must-not-exist
    node /opt/workspace-runtime/workspace-runtime-image-smoke.mjs
    echo NATIVE_SANDBOX_POLICY_OK
  '
