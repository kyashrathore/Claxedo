# Inside a Claxedo tab, Codex runs Claxedo's lifecycle hooks from session flags,
# so no Codex config file is written. Codex skips hooks it has not trusted, and
# rejects the bypass flag when it is repeated.
if [ -n "${CLAXEDO_TAB_ID:-}" ]; then
  _claxedo_bypass="--dangerously-bypass-hook-trust"
  for _claxedo_arg in "$@"; do
    [ "$_claxedo_arg" = "--" ] && break
    if [ "$_claxedo_arg" = "--dangerously-bypass-hook-trust" ]; then
      _claxedo_bypass=""
      break
    fi
  done
  exec "$REAL_BIN" --enable hooks ${_claxedo_bypass:+"$_claxedo_bypass"} {{HOOK_FLAGS}} "$@"
fi

exec "$REAL_BIN" "$@"
