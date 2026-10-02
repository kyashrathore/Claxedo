#!/usr/bin/env bash
# Codex's real Linux sandbox uses unprivileged user namespaces. Only relax the
# AppArmor namespace restriction on disposable CI runners, then prove it works.
set -euo pipefail

if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
unshare --user --map-root-user true

# Keep outbound connections from taking ports between a fixture's reservation
# probe and its actual listener. Preserve any ranges the host already reserves.
port_range="${CLAXEDO_E2E_PORT_RANGE:-46100-46199}"
if [[ ! "$port_range" =~ ^([0-9]+)-([0-9]+)$ ]]; then
  echo "Invalid CLAXEDO_E2E_PORT_RANGE: $port_range" >&2
  exit 1
fi
first_port=$((10#${BASH_REMATCH[1]}))
last_port=$((10#${BASH_REMATCH[2]}))
if (( first_port < 1024 || last_port > 65535 || first_port > last_port )); then
  echo "Invalid CLAXEDO_E2E_PORT_RANGE: $port_range" >&2
  exit 1
fi
reserved_ports="$(sysctl -n net.ipv4.ip_local_reserved_ports)"
sudo sysctl -w "net.ipv4.ip_local_reserved_ports=${reserved_ports:+$reserved_ports,}$port_range"
