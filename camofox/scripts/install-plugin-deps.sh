#!/bin/sh
# Install system packages declared by plugins listed in camofox.config.json.
# Each plugin can have an apt.txt (one package per line) and a post-install.sh.
# If no config file or no plugins key, installs deps for all plugins in plugins/.

set -e

CONFIG="/app/camofox.config.json"
PLUGINS_DIR="/app/plugins"

# Read plugin list from camofox.config.json, or fall back to all plugin dirs
if [ -f "$CONFIG" ] && command -v node >/dev/null 2>&1; then
  PLUGIN_LIST=$(node -e "
    const c = JSON.parse(require('fs').readFileSync('$CONFIG','utf-8'));
    if (Array.isArray(c.plugins)) {
      console.log(c.plugins.join(' '));
    } else if (c.plugins && typeof c.plugins === 'object') {
      console.log(Object.keys(c.plugins).join(' '));
    }
  " 2>/dev/null || echo "")
fi

if [ -z "$PLUGIN_LIST" ]; then
  # No config or no plugins key -- use all plugin directories
  PLUGIN_LIST=""
  for d in "$PLUGINS_DIR"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in _*|.*) continue ;; esac
    PLUGIN_LIST="$PLUGIN_LIST $name"
  done
fi

echo "[install-plugin-deps] Plugins:$PLUGIN_LIST"

# Collect apt packages
PKGS=""
for name in $PLUGIN_LIST; do
  f="$PLUGINS_DIR/$name/apt.txt"
  [ -f "$f" ] || continue
  # Tolerate a CRLF checkout: a trailing \r rides along into the package name
  # and apt fails with "Unable to locate package". The `|| [ -n "$line" ]` picks
  # up a last line with no trailing newline, which plain `read` drops.
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(printf '%s' "$line" | tr -d '\r')
    case "$line" in \#*|"") continue ;; esac
    PKGS="$PKGS $line"
  done < "$f"
done

if [ -n "$PKGS" ]; then
  echo "[install-plugin-deps] Installing:$PKGS"
  # Deliberately NOT an `a && b && c` chain: `set -e` does not abort on a
  # non-final command of an AND-list, so a failed install used to exit 0 and the
  # build happily produced an image missing every plugin's system packages.
  apt-get update
  apt-get install -y $PKGS
  rm -rf /var/lib/apt/lists/*
else
  echo "[install-plugin-deps] No apt dependencies"
fi

# Run post-install hooks
for name in $PLUGIN_LIST; do
  hook="$PLUGINS_DIR/$name/post-install.sh"
  [ -x "$hook" ] || continue
  echo "[install-plugin-deps] Running post-install for $name"
  "$hook"
done
