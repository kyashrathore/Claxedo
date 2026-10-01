if [ -n "$CLAXEDO_TAB_ID" ] && [ -f {{hookScript|sh}} ]; then
  {{prefix}}_HOOKS_DIR={{projectDir}}
  {{prefix}}_HOOK_FILE="${{prefix}}_HOOKS_DIR/{{projectFile}}"
  {{prefix}}_HOOKS={{project|sh}}

  if [ "$(cat "${{prefix}}_HOOK_FILE" 2>/dev/null)" != "$(printf '%s\n' "${{prefix}}_HOOKS")" ]; then
    mkdir -p "${{prefix}}_HOOKS_DIR" 2>/dev/null &&
      printf '%s\n' "${{prefix}}_HOOKS" > "${{prefix}}_HOOK_FILE.tmp.$$" 2>/dev/null &&
      mv -f "${{prefix}}_HOOK_FILE.tmp.$$" "${{prefix}}_HOOK_FILE" 2>/dev/null
  fi

  {{prefix}}_EXCLUDE=".git/info/exclude"
  if [ -d ".git/info" ] && ! grep -qxF "{{projectPath}}" "${{prefix}}_EXCLUDE" 2>/dev/null; then
    # Never join the line onto a last entry the person left without a newline.
    [ -s "${{prefix}}_EXCLUDE" ] && [ -n "$(tail -c 1 "${{prefix}}_EXCLUDE")" ] && printf '\n' >> "${{prefix}}_EXCLUDE"
    printf '%s\n' "{{projectPath}}" >> "${{prefix}}_EXCLUDE" 2>/dev/null
  fi
fi
