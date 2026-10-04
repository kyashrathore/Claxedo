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
if docker info --format '{{json .SecurityOptions}}' | grep -Fq 'name=apparmor'; then
  sudo apparmor_parser -r -W "$policy/apparmor.profile"
  sudo grep -Fxq 'codex-security-container (enforce)' /sys/kernel/security/apparmor/profiles
  apparmor=(--security-opt apparmor=codex-security-container)
fi

docker run --rm --init --cap-drop ALL --cap-add SETFCAP --security-opt no-new-privileges \
  --security-opt "seccomp=$policy/seccomp.json" "${apparmor[@]}" \
  --entrypoint sh "$image" -lc '
    set -eu
    grep -Eq "^CapEff:[[:space:]]+0000000080000000$" /proc/self/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status
    unshare -Ur true
    if unshare -m true; then
      echo "Unexpected mount namespace authority outside a user namespace" >&2
      exit 1
    fi
    mkdir -p /workspace /root/.codex-policy-home
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
