{{MARKER}}
{{ENV_SAVE}}
_claxedo_home="${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_claxedo_home"
if [[ -o interactive ]]; then
  [[ -f "$_claxedo_home/.zlogin" ]] && source "$_claxedo_home/.zlogin"
fi
{{ENV_RESTORE}}
{{PRECMD_HOOK}}
{{PATH_PREPEND}}
rehash 2>/dev/null || true
# One-shot shell-ready marker for terminal readiness detection.
# Uses precmd so it fires AFTER direnv and other hooks complete.
_claxedo_shell_ready() {
  precmd_functions=(${precmd_functions:#_claxedo_shell_ready})
  printf '\033]777;claxedo-shell-ready\007'
}
precmd_functions=(${precmd_functions[@]} _claxedo_shell_ready)
export ZDOTDIR="$_claxedo_home"
