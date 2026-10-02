#!/usr/bin/env bash
# Codex's real Linux sandbox uses unprivileged user namespaces. Only relax the
# AppArmor namespace restriction on disposable CI runners, then prove it works.
set -euo pipefail

if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
unshare --user --map-root-user true
