# Load packages/claxedo-server/.env into the environment, for sourcing.
#
#   . "$REPO_ROOT/script/load-server-env.sh"
#
# The embedded server reads its configuration from the environment it inherits
# and nothing else — there is no dotenv anywhere in the tree. So a key that
# lives only in the server's .env (GITHUB_CLIENT_ID, DAYTONA_API_KEY, the
# MODAL_* pair) is simply absent at runtime unless the launching shell exported
# it first, and the feature that needs it fails in a way that looks like a bug
# in the feature.
#
# This is a DEVELOPMENT convenience and deliberately not wired into the packaged
# app: those files hold real secrets belonging to whoever checked them out, and
# a shipped binary must not read them.
#
# Values are taken verbatim, so `KEY=a b c` and `KEY="quoted"` both work; the
# only processing is stripping one layer of surrounding quotes. Lines that are
# blank, commented, or lack a `=` are skipped. Anything already exported wins,
# so an explicit `FOO=bar script/…` override is not clobbered by the file.

claxedo_load_server_env() {
  local repo_root="$1"
  local file
  local loaded=0
  local claxedo_loaded_keys=""

  # `.env.local` last so it wins on conflict, matching the usual convention.
  for file in "$repo_root/packages/claxedo-server/.env" "$repo_root/packages/claxedo-server/.env.local"; do
    [ -f "$file" ] || continue
    local line key value
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ""|"#"*) continue ;;
        *"="*) ;;
        *) continue ;;
      esac
      key="${line%%=*}"
      value="${line#*=}"
      # Trim whitespace around the key, and tolerate `export KEY=`.
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      key="${key#export }"
      case "$key" in
        ""|*[!A-Za-z0-9_]*) continue ;;
      esac
      value="${value#"${value%%[![:space:]]*}"}"
      # One layer of surrounding quotes, if the value is wrapped in a matched pair.
      case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
      esac
      # An explicit export from the CALLER is an intentional override and is
      # left alone; a value this loader set from the earlier file is not, so
      # `.env.local` can still win over `.env`.
      # `env`/case rather than indirect expansion: this file is sourced by
      # whatever shell the developer runs, and `${!key}` is not portable to zsh.
      case " $claxedo_loaded_keys " in
        *" $key "*) ;;
        *) if env | grep -q "^$key="; then continue; fi ;;
      esac
      claxedo_loaded_keys="$claxedo_loaded_keys $key"
      export "$key=$value"
      loaded=$((loaded + 1))
    done < "$file"
  done

  if [ "$loaded" -gt 0 ]; then
    echo "server env: loaded $loaded value(s) from packages/claxedo-server/.env*"
  else
    echo "server env: nothing to load (no .env, or every key already exported)"
  fi
}
