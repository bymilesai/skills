#!/bin/sh
set -eu

main() {
  : "${HOME:?HOME must be set}"
  umask 077

  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/miles-install.XXXXXX")
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  source_dir=${MILES_INSTALL_SOURCE_DIR:-}
  if [ -n "$source_dir" ]; then
    source_dir=$(cd "$source_dir" && pwd)
  else
    source_dir=$(download_source "$tmp_dir")
  fi

  if [ ! -f "$source_dir/miles/SKILL.md" ]; then
    fail "Could not find miles/SKILL.md in $source_dir"
  fi

  install_skill "$source_dir/miles" "$HOME/.agents/skills"
  install_skill "$source_dir/miles" "${CODEX_HOME:-$HOME/.codex}/skills"
  install_skill "$source_dir/miles" "$HOME/.claude/skills"
  install_skill "$source_dir/miles" "$HOME/.cursor/skills"
  install_skill "$source_dir/miles" "$HOME/.config/opencode/skills"
  install_launcher "$HOME/.agents/skills/miles/scripts/miles"

  cat <<'MSG'

Miles is installed.

Next steps:
  1. Restart or reload your coding agent so it discovers the new skill.
  2. Ask: "Use Miles to help me design a site."
  3. On first use, run `~/.miles/bin/miles login` if Miles asks you to authenticate.

Installed skill locations:
  ~/.agents/skills/miles
  ~/.codex/skills/miles
  ~/.claude/skills/miles
  ~/.cursor/skills/miles
  ~/.config/opencode/skills/miles

Convenience CLI:
  ~/.miles/bin/miles

MSG
}

download_source() {
  tmp_dir=$1
  archive_path="$tmp_dir/skills.tar.gz"
  repo_url=${MILES_SKILLS_REPO:-https://github.com/bymilesai/skills}
  ref=${MILES_SKILLS_REF:-trunk}
  archive_url=${MILES_SKILLS_ARCHIVE_URL:-$repo_url/archive/refs/heads/$ref.tar.gz}

  log "Downloading Miles skill from $archive_url"
  download_file "$archive_url" "$archive_path"

  mkdir -p "$tmp_dir/source"
  tar -xzf "$archive_path" -C "$tmp_dir/source"

  source_dir=$(find "$tmp_dir/source" -mindepth 1 -maxdepth 1 -type d | sed -n '1p')
  if [ -z "$source_dir" ]; then
    fail "Downloaded archive did not contain a source directory"
  fi
  printf '%s\n' "$source_dir"
}

download_file() {
  url=$1
  output=$2

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
    return
  fi

  fail "Install needs curl or wget to download the Miles skill"
}

install_skill() {
  skill_source=$1
  parent_dir=$2
  dest_dir="$parent_dir/miles"
  tmp_dest="$parent_dir/.miles.tmp.$$"
  old_dest="$parent_dir/.miles.previous.$$"

  mkdir -p "$parent_dir"
  rm -rf "$tmp_dest" "$old_dest"
  mkdir -p "$tmp_dest"

  copy_dir "$skill_source" "$tmp_dest"

  if [ -f "$tmp_dest/scripts/miles" ]; then
    chmod 755 "$tmp_dest/scripts/miles" 2>/dev/null || true
  fi
  if [ -f "$tmp_dest/scripts/miles-cli.mjs" ]; then
    chmod 755 "$tmp_dest/scripts/miles-cli.mjs" 2>/dev/null || true
  fi

  if [ -e "$dest_dir" ]; then
    if [ ! -d "$dest_dir" ]; then
      rm -rf "$tmp_dest"
      fail "$dest_dir exists but is not a directory"
    fi
    mv "$dest_dir" "$old_dest"
  fi

  mv "$tmp_dest" "$dest_dir"
  rm -rf "$old_dest"
  log "Installed $dest_dir"
}

copy_dir() {
  source=$1
  dest=$2

  if command -v tar >/dev/null 2>&1; then
    (cd "$source" && tar -cf - .) | (cd "$dest" && tar -xf -)
    return
  fi

  if command -v cp >/dev/null 2>&1; then
    cp -R "$source/." "$dest/"
    return
  fi

  fail "Install needs tar or cp to copy the Miles skill"
}

install_launcher() {
  target=$1
  bin_dir="$HOME/.miles/bin"
  launcher="$bin_dir/miles"

  mkdir -p "$bin_dir"

  cat >"$launcher" <<EOF
#!/bin/sh
exec "$target" "\$@"
EOF

  chmod 755 "$launcher" 2>/dev/null || true
}

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Miles install failed: %s\n' "$*" >&2
  exit 1
}

main "$@"
