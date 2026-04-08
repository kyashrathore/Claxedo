{{MARKER}}
{{ENV_SAVE}}
_claxedo_home="${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_claxedo_home"
[[ -f "$_claxedo_home/.zshrc" ]] && source "$_claxedo_home/.zshrc"
{{ENV_RESTORE}}
{{PATH_PREPEND}}
{{PRECMD_HOOK}}
rehash 2>/dev/null || true
export ZDOTDIR={{SHELL_DIR_QUOTED}}
