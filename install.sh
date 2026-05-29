#!/bin/sh
set -eu

DRY_RUN=0
EXPLAIN=0
JSON_OUTPUT=0
AGENT=all

main() {
  : "${HOME:?HOME must be set}"
  umask 077
  parse_args "$@"

  if [ "$EXPLAIN" -eq 1 ]; then
    print_explain
    exit 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$JSON_OUTPUT" -eq 1 ]; then
      print_json_plan
    else
      print_dry_run
    fi
    exit 0
  fi

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

  destination_parent_dirs | while IFS= read -r parent_dir; do
    install_skill "$source_dir/miles" "$parent_dir"
  done
  install_launcher "$(primary_launcher_target)"

  cat <<'MSG'

Miles is installed.

Restart or reload your coding agent so it discovers the new skill.
Then ask: "Use Miles to design my website."

MSG
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      --explain | --print-summary)
        EXPLAIN=1
        ;;
      --json)
        JSON_OUTPUT=1
        ;;
      --agent)
        shift
        if [ "$#" -eq 0 ]; then
          fail "--agent requires a value"
        fi
        AGENT=$1
        ;;
      -h | --help)
        print_help
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done

  case "$AGENT" in
    all | shared | codex | claude | cursor | opencode) ;;
    *)
      fail "Unsupported --agent value: $AGENT"
      ;;
  esac
}

print_help() {
  cat <<'MSG'
Miles agent skill installer

Usage:
  sh install.sh [--dry-run] [--json] [--explain] [--agent all|shared|codex|claude|cursor|opencode]

Examples:
  curl -fsSL https://start.bymiles.ai/install.sh | sh
  curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run
  curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run --json
  sh install.sh --agent codex
MSG
}

print_explain() {
  cat <<EOF
Miles installer summary:
- Downloads the Miles skill from $(archive_url).
- Installs the miles/ skill into local agent skill directories.
- Creates a convenience launcher at ~/.miles/bin/miles.
- Requires Node.js 20+ at runtime.
- Does not use npx and does not open a browser.

Recommended install command:
  curl -fsSL https://start.bymiles.ai/install.sh | sh
EOF
}

print_dry_run() {
  cat <<EOF
Miles install dry run

Source archive: $(archive_url)
Agent mode: $AGENT
Node.js: $(node_status_text)

Destinations:
EOF

  destination_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    printf '  - %s (%s)\n' "$(display_path "$dest_dir")" "$(exists_status "$dest_dir")"
  done

  cat <<EOF

Launcher:
  $(display_path "$HOME/.miles/bin/miles") -> $(display_path "$(primary_launcher_target)")

No files were written.
EOF
}

print_json_plan() {
  printf '{\n'
  printf '  "name": "miles",\n'
  printf '  "action": "install_agent_skill",\n'
  printf '  "source": "%s",\n' "$(json_escape "$(archive_url)")"
  printf '  "agent": "%s",\n' "$(json_escape "$AGENT")"
  printf '  "destinations": [\n'
  first=1
  destination_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ',\n'
    fi
    printf '    { "path": "%s", "exists": %s }' \
      "$(json_escape "$(display_path "$dest_dir")")" \
      "$(json_bool_exists "$dest_dir")"
  done
  printf '\n  ],\n'
  printf '  "launcher": {\n'
  printf '    "path": "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles")")"
  printf '    "target": "%s"\n' "$(json_escape "$(display_path "$(primary_launcher_target)")")"
  printf '  },\n'
  printf '  "requires": {\n'
  printf '    "node": ">=20",\n'
  printf '    "nodeFound": %s,\n' "$(node_found_json)"
  printf '    "nodeVersion": "%s",\n' "$(json_escape "$(node_version_text)")"
  printf '    "nodeOk": %s\n' "$(node_ok_json)"
  printf '  }\n'
  printf '}\n'
}

archive_url() {
  repo_url=${MILES_SKILLS_REPO:-https://github.com/bymilesai/skills}
  ref=${MILES_SKILLS_REF:-trunk}
  printf '%s\n' "${MILES_SKILLS_ARCHIVE_URL:-$repo_url/archive/refs/heads/$ref.tar.gz}"
}

download_source() {
  tmp_dir=$1
  archive_path="$tmp_dir/skills.tar.gz"

  log "Downloading Miles skill from $(archive_url)"
  download_file "$(archive_url)" "$archive_path"

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

destination_parent_dirs() {
  case "$AGENT" in
    all)
      printf '%s\n' \
        "$HOME/.agents/skills" \
        "${CODEX_HOME:-$HOME/.codex}/skills" \
        "$HOME/.claude/skills" \
        "$HOME/.cursor/skills" \
        "$HOME/.config/opencode/skills"
      ;;
    shared)
      printf '%s\n' "$HOME/.agents/skills"
      ;;
    codex)
      printf '%s\n' "${CODEX_HOME:-$HOME/.codex}/skills"
      ;;
    claude)
      printf '%s\n' "$HOME/.claude/skills"
      ;;
    cursor)
      printf '%s\n' "$HOME/.cursor/skills"
      ;;
    opencode)
      printf '%s\n' "$HOME/.config/opencode/skills"
      ;;
  esac
}

primary_launcher_target() {
  case "$AGENT" in
    all | shared)
      printf '%s\n' "$HOME/.agents/skills/miles/scripts/miles"
      ;;
    codex)
      printf '%s\n' "${CODEX_HOME:-$HOME/.codex}/skills/miles/scripts/miles"
      ;;
    claude)
      printf '%s\n' "$HOME/.claude/skills/miles/scripts/miles"
      ;;
    cursor)
      printf '%s\n' "$HOME/.cursor/skills/miles/scripts/miles"
      ;;
    opencode)
      printf '%s\n' "$HOME/.config/opencode/skills/miles/scripts/miles"
      ;;
  esac
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

node_status_text() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'not found (requires Node.js 20+)\n'
    return
  fi

  version=$(node -v 2>/dev/null || true)
  major=$(printf '%s' "$version" | sed 's/^v//; s/\..*$//')
  case "$major" in
    '' | *[!0-9]*)
      printf '%s (could not parse; requires Node.js 20+)\n' "$version"
      ;;
    *)
      if [ "$major" -ge 20 ]; then
        printf '%s (ok)\n' "$version"
      else
        printf '%s (requires Node.js 20+)\n' "$version"
      fi
      ;;
  esac
}

node_version_text() {
  if command -v node >/dev/null 2>&1; then
    node -v 2>/dev/null || true
  fi
}

node_found_json() {
  if command -v node >/dev/null 2>&1; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

node_ok_json() {
  version=$(node_version_text)
  major=$(printf '%s' "$version" | sed 's/^v//; s/\..*$//')
  case "$major" in
    '' | *[!0-9]*)
      printf 'false\n'
      ;;
    *)
      if [ "$major" -ge 20 ]; then
        printf 'true\n'
      else
        printf 'false\n'
      fi
      ;;
  esac
}

exists_status() {
  if [ -e "$1" ]; then
    printf 'exists\n'
  else
    printf 'will create\n'
  fi
}

json_bool_exists() {
  if [ -e "$1" ]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

display_path() {
  path=$1
  case "$path" in
    "$HOME")
      printf '~\n'
      ;;
    "$HOME"/*)
      printf '~/%s\n' "${path#"$HOME"/}"
      ;;
    *)
      printf '%s\n' "$path"
      ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Miles install failed: %s\n' "$*" >&2
  exit 1
}

main "$@"
