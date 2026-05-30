#!/bin/sh
set -eu

INSTALLER_VERSION=2026.05.30.3
DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS=86400

DRY_RUN=0
JSON_OUTPUT=0
AGENT=all
ACTION=install
PURGE=0
FORCE_CHECK=0

main() {
  : "${HOME:?HOME must be set}"
  umask 077
  parse_args "$@"

  case "$ACTION" in
    explain)
      print_explain
      ;;
    status)
      print_status
      ;;
    check-update)
      check_update
      ;;
    update)
      run_update
      ;;
    uninstall)
      run_uninstall
      ;;
    install)
      run_install
      ;;
    *)
      fail "Unknown action: $ACTION"
      ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      --explain | --print-summary)
        ACTION=explain
        ;;
      --json)
        JSON_OUTPUT=1
        ;;
      --status | status)
        ACTION=status
        ;;
      --check-update | check-update)
        ACTION=check-update
        ;;
      --update | update)
        ACTION=update
        ;;
      --uninstall | uninstall)
        ACTION=uninstall
        ;;
      --purge)
        PURGE=1
        ;;
      --force | --force-check)
        FORCE_CHECK=1
        ;;
      --agent)
        shift
        if [ "$#" -eq 0 ]; then
          fail "--agent requires a value"
        fi
        AGENT=$1
        ;;
      -h | --help | help)
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
Miles agent skill lifecycle manager

Usage:
  sh install.sh [--dry-run] [--json] [--explain] [--agent all|shared|codex|claude|cursor|opencode]
  sh install.sh --status [--json]
  sh install.sh --check-update [--json] [--force]
  sh install.sh --update [--dry-run] [--agent all|shared|codex|claude|cursor|opencode]
  sh install.sh --uninstall [--dry-run] [--purge]

Installed helper:
  ~/.miles/bin/miles-skill status
  ~/.miles/bin/miles-skill check-update --json
  ~/.miles/bin/miles-skill update
  ~/.miles/bin/miles-skill uninstall

Examples:
  curl -fsSL https://start.bymiles.ai/install.sh | sh
  curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run
  curl -fsSL https://start.bymiles.ai/install.sh | sh -s -- --dry-run --json
  sh install.sh --agent codex
MSG
}

run_install() {
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$JSON_OUTPUT" -eq 1 ]; then
      print_json_plan
    else
      print_dry_run
    fi
    exit 0
  fi

  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  source_dir=$(resolve_source_dir "$tmp_dir")
  require_skill_source "$source_dir"

  parents_file="$tmp_dir/destinations.txt"
  destination_parent_dirs >"$parents_file"

  install_from_source "$source_dir" "$parents_file" "$AGENT" "$tmp_dir"

  cat <<'MSG'

Miles is installed.

Your agent should now verify Miles and complete login if needed:
  ~/.miles/bin/miles-skill check-update --json
  ~/.miles/bin/miles doctor --json
  ~/.miles/bin/miles whoami
  ~/.miles/bin/miles login --json
  ~/.miles/bin/miles login --poll --json

Do not ask the user to run login manually. If login is needed, show the device
code and link, keep listening while the user authorizes, then continue.

After login, ask what site to create. A useful prompt is:
"Use Miles to design a website for [business/project]. It should feel [style] and help visitors [goal]."
If you already have a WordPress site, include its URL and what you want changed.
If your agent does not see the new skill, start a new chat or reload the agent window.

MSG
}

run_update() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_update_dry_run
    exit 0
  fi

  if [ ! -f "$(destinations_file)" ]; then
    fail "No Miles install receipt found. Run the installer first."
  fi

  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  source_dir=$(resolve_source_dir "$tmp_dir")
  require_skill_source "$source_dir"

  install_from_source "$source_dir" "$(destinations_file)" "$(receipt_value agent all)" "$tmp_dir"
  write_update_cache "$(source_version "$source_dir")" "$(source_version "$source_dir")" false false

  cat <<'MSG'

Miles is updated.

Continue with Miles now.
If your agent does not see the updated skill, start a new chat or reload the agent window.

MSG
}

run_uninstall() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_uninstall_plan
    exit 0
  fi

  uninstall_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    if is_miles_owned_skill_dir "$dest_dir"; then
      rm -rf "$dest_dir"
      log "Removed $dest_dir"
    fi
  done

  rm -f "$HOME/.miles/bin/miles" "$HOME/.miles/bin/miles-skill" "$(runtime_binary_path)"
  rm -f "$(receipt_file)" "$(destinations_file)" "$(update_cache_file)" "$(update_last_check_file)" "$(installer_copy)"
  rmdir "$(install_dir)" 2>/dev/null || true

  if [ "$PURGE" -eq 1 ]; then
    rm -f "$HOME/.miles/credentials.json" "$HOME/.miles/last-response"
    rm -rf "$HOME/.miles/screenshots"
    rmdir "$HOME/.miles/bin" "$HOME/.miles" 2>/dev/null || true
  fi

  if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '{\n'
    printf '  "ok": true,\n'
    printf '  "action": "uninstall",\n'
    printf '  "purgedCredentials": %s\n' "$(json_bool "$PURGE")"
    printf '}\n'
    exit 0
  fi

  if [ "$PURGE" -eq 1 ]; then
    printf 'Miles is uninstalled and local Miles login state was removed.\n'
  else
    printf 'Miles is uninstalled. Local Miles login state was kept.\n'
  fi
}

print_explain() {
  cat <<EOF
Miles installer summary:
- Reads the install manifest from $(manifest_url).
- Downloads the Miles skill source archive named by that manifest.
- Verifies the source archive SHA-256 when the manifest publishes sourceSha256.
- Downloads and verifies a bundled Miles CLI runtime when the manifest publishes one for this platform.
- Installs the miles/ skill into local agent skill directories.
- Creates convenience launchers at ~/.miles/bin/miles and ~/.miles/bin/miles-skill.
- Writes an install receipt at ~/.miles/install/receipt.json.
- Checks for skill updates at most once every 24 hours when agents ask it to.
- Uses the bundled Miles CLI runtime when available; the JavaScript fallback requires Node.js 20+.
- Does not use sudo, npx, eval, base64 payloads, or browser automation.

Canonical security summary:
  https://start.bymiles.ai/install-security.md

Recommended install command:
  curl -fsSL https://start.bymiles.ai/install.sh | sh
EOF
}

print_dry_run() {
  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  manifest_file=''
  source_url=$(archive_url)
  source_sha256=''
  payload_manifest=$(payload_manifest_url)

  if manifest_file=$(manifest_file_for_read "$tmp_dir"); then
    source_url=$(manifest_source_url "$manifest_file")
    source_sha256=$(manifest_source_sha256 "$manifest_file")
    payload_manifest=$(manifest_payload_manifest_url "$manifest_file")
  fi

  cat <<EOF
Miles install dry run

Source archive: $source_url
Source SHA-256: $(sha256_status_text "$source_sha256")
Manifest: $(manifest_url)
Payload manifest: $payload_manifest
Agent mode: $AGENT
Bundled CLI runtime: $(runtime_status_text "$manifest_file")
Node.js fallback: $(node_status_text)
Update check gate: 24 hours

Destinations:
EOF

  destination_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    printf '  - %s (%s)\n' "$(display_path "$dest_dir")" "$(exists_status "$dest_dir")"
  done

  cat <<EOF

Launchers:
  $(display_path "$HOME/.miles/bin/miles") -> $(display_path "$(primary_launcher_target)")
  $(display_path "$HOME/.miles/bin/miles-skill") -> $(display_path "$(installer_copy)")
  $(display_path "$(runtime_binary_path)") (bundled runtime when available)

Receipt:
  $(display_path "$(receipt_file)")

Payload:
EOF

  print_payload_summary "$tmp_dir" "$payload_manifest"
  rm -rf "$tmp_dir"

  cat <<EOF

No files were written.
EOF
}

print_update_dry_run() {
  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  manifest_file=''
  source_url=$(archive_url)
  source_sha256=''

  if manifest_file=$(manifest_file_for_read "$tmp_dir"); then
    source_url=$(manifest_source_url "$manifest_file")
    source_sha256=$(manifest_source_sha256 "$manifest_file")
  fi

  cat <<EOF
Miles update dry run

Source archive: $source_url
Source SHA-256: $(sha256_status_text "$source_sha256")
Installed version: $(receipt_value version unknown)
Latest manifest: $(manifest_url)

Destinations:
EOF

  uninstall_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    printf '  - %s (%s)\n' "$(display_path "$dest_dir")" "$(exists_status "$dest_dir")"
  done

  cat <<EOF

No files were written.
EOF

  rm -rf "$tmp_dir"
}

print_uninstall_plan() {
  if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '{\n'
    printf '  "name": "miles",\n'
    printf '  "action": "uninstall_agent_skill",\n'
    printf '  "purge": %s,\n' "$(json_bool "$PURGE")"
    printf '  "destinations": [\n'
    print_uninstall_destinations_json_from_stream uninstall_parent_dirs
    printf '\n  ],\n'
    printf '  "launchers": [\n'
    printf '    "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles")")"
    printf '    "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles-skill")")"
    printf '    "%s"\n' "$(json_escape "$(display_path "$(runtime_binary_path)")")"
    printf '  ]\n'
    printf '}\n'
    return
  fi

  cat <<EOF
Miles uninstall dry run

Skill directories:
EOF

  uninstall_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    if is_miles_owned_skill_dir "$dest_dir"; then
      printf '  - %s (will remove)\n' "$(display_path "$dest_dir")"
    elif [ -e "$dest_dir" ]; then
      printf '  - %s (not Miles-owned; will keep)\n' "$(display_path "$dest_dir")"
    else
      printf '  - %s (not installed)\n' "$(display_path "$dest_dir")"
    fi
  done

  cat <<EOF

Launchers:
  $(display_path "$HOME/.miles/bin/miles")
  $(display_path "$HOME/.miles/bin/miles-skill")
  $(display_path "$(runtime_binary_path)")

Login state:
  $(display_path "$HOME/.miles/credentials.json") $(purge_status_text)

No files were removed.
EOF
}

print_json_plan() {
  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  manifest_file=''
  source_url=$(archive_url)
  source_sha256=''
  payload_manifest=$(payload_manifest_url)

  if manifest_file=$(manifest_file_for_read "$tmp_dir"); then
    source_url=$(manifest_source_url "$manifest_file")
    source_sha256=$(manifest_source_sha256 "$manifest_file")
    payload_manifest=$(manifest_payload_manifest_url "$manifest_file")
  fi

  printf '{\n'
  printf '  "name": "miles",\n'
  printf '  "action": "install_agent_skill",\n'
  printf '  "source": "%s",\n' "$(json_escape "$source_url")"
  if [ -n "$source_sha256" ]; then
    printf '  "sourceSha256": "%s",\n' "$(json_escape "$source_sha256")"
  else
    printf '  "sourceSha256": null,\n'
  fi
  printf '  "manifest": "%s",\n' "$(json_escape "$(manifest_url)")"
  printf '  "payloadManifest": "%s",\n' "$(json_escape "$payload_manifest")"
  printf '  "installerVersion": "%s",\n' "$(json_escape "$INSTALLER_VERSION")"
  printf '  "agent": "%s",\n' "$(json_escape "$AGENT")"
  printf '  "updateCheckIntervalSeconds": %s,\n' "$(update_check_interval_seconds)"
  printf '  "destinations": [\n'
  print_destinations_json_from_stream destination_parent_dirs
  printf '\n  ],\n'
  printf '  "launchers": {\n'
  printf '    "miles": {\n'
  printf '      "path": "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles")")"
  printf '      "target": "%s"\n' "$(json_escape "$(display_path "$(primary_launcher_target)")")"
  printf '    },\n'
  printf '    "milesSkill": {\n'
  printf '      "path": "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles-skill")")"
  printf '      "target": "%s"\n' "$(json_escape "$(display_path "$(installer_copy)")")"
  printf '    },\n'
  printf '    "runtime": {\n'
  printf '      "path": "%s"\n' "$(json_escape "$(display_path "$(runtime_binary_path)")")"
  printf '    }\n'
  printf '  },\n'
  printf '  "receipt": "%s",\n' "$(json_escape "$(display_path "$(receipt_file)")")"
  printf '  "requires": {\n'
  printf '    "bundledRuntime": '
  print_runtime_plan_json "$manifest_file"
  printf ',\n'
  printf '    "nodeFallback": {\n'
  printf '      "node": ">=20",\n'
  printf '      "nodeFound": %s,\n' "$(node_found_json)"
  printf '      "nodeVersion": "%s",\n' "$(json_escape "$(node_version_text)")"
  printf '      "nodeOk": %s\n' "$(node_ok_json)"
  printf '    }\n'
  printf '  },\n'
  printf '  "payload": '
  print_payload_json "$tmp_dir" "$payload_manifest"
  printf '\n'
  printf '}\n'

  rm -rf "$tmp_dir"
}

print_status() {
  installed=false
  if [ -f "$(receipt_file)" ]; then
    installed=true
  fi

  if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '{\n'
    printf '  "name": "miles",\n'
    printf '  "installed": %s,\n' "$installed"
    printf '  "version": "%s",\n' "$(json_escape "$(receipt_value version unknown)")"
    printf '  "agent": "%s",\n' "$(json_escape "$(receipt_value agent unknown)")"
    printf '  "installerVersion": "%s",\n' "$(json_escape "$(receipt_value installerVersion unknown)")"
    printf '  "receipt": "%s",\n' "$(json_escape "$(display_path "$(receipt_file)")")"
    printf '  "updateCheckIntervalSeconds": %s,\n' "$(update_check_interval_seconds)"
    printf '  "lastUpdateCheckEpoch": %s,\n' "$(last_update_check_epoch_json)"
    printf '  "destinations": [\n'
    print_destinations_json_from_stream status_parent_dirs
    printf '\n  ],\n'
    printf '  "launchers": {\n'
    printf '    "miles": %s,\n' "$(json_bool_exists "$HOME/.miles/bin/miles")"
    printf '    "milesSkill": %s,\n' "$(json_bool_exists "$HOME/.miles/bin/miles-skill")"
    printf '    "runtime": %s\n' "$(json_bool_exists "$(runtime_binary_path)")"
    printf '  }\n'
    printf '}\n'
    return
  fi

  printf 'Miles skill status\n\n'
  printf 'Installed: %s\n' "$installed"
  printf 'Version: %s\n' "$(receipt_value version unknown)"
  printf 'Agent mode: %s\n' "$(receipt_value agent unknown)"
  printf 'Receipt: %s\n\n' "$(display_path "$(receipt_file)")"
  printf 'Destinations:\n'
  status_parent_dirs | while IFS= read -r parent_dir; do
    dest_dir="$parent_dir/miles"
    printf '  - %s (%s)\n' "$(display_path "$dest_dir")" "$(exists_status "$dest_dir")"
  done
}

check_update() {
  now=$(now_epoch)
  interval=$(update_check_interval_seconds)

  if [ ! -f "$(receipt_file)" ]; then
    print_update_result true false false false unknown false "No Miles install receipt found. Run the installer first."
    return
  fi

  if [ "$FORCE_CHECK" -eq 0 ] && [ -f "$(update_last_check_file)" ] && [ -f "$(update_cache_file)" ]; then
    last=$(cat "$(update_last_check_file)" 2>/dev/null || printf '0')
    if is_integer "$last"; then
      age=$((now - last))
      if [ "$age" -ge 0 ] && [ "$age" -lt "$interval" ]; then
        cached_update_available=$(cache_value updateAvailable false)
        cached_urgent=$(cache_value urgent false)
        cached_should_prompt=false
        if [ "$cached_update_available" = true ] && [ "$cached_urgent" = true ]; then
          cached_should_prompt=true
        fi
        print_update_result false true "$cached_update_available" "$cached_should_prompt" "$(cache_value latestVersion unknown)" "$cached_urgent" ""
        return
      fi
    fi
  fi

  tmp_dir=$(make_tmp_dir)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  manifest_file="$tmp_dir/version.json"

  if ! try_download_file "$(manifest_url)" "$manifest_file"; then
    print_update_result true false false false unknown false "Could not fetch update manifest"
    return
  fi

  latest_version=$(json_value_file "$manifest_file" version)
  if [ -z "$latest_version" ]; then
    latest_version=unknown
  fi
  urgent=$(json_bool_file "$manifest_file" urgent false)
  installed_version=$(receipt_value version unknown)

  update_available=false
  should_prompt=false
  if [ "$latest_version" != unknown ] && [ "$installed_version" != unknown ] && [ "$installed_version" != "$latest_version" ]; then
    update_available=true
    should_prompt=true
  fi

  write_update_cache "$installed_version" "$latest_version" "$update_available" "$urgent"
  printf '%s\n' "$now" >"$(update_last_check_file)"
  print_update_result true false "$update_available" "$should_prompt" "$latest_version" "$urgent" ""
}

print_update_result() {
  checked=$1
  skipped=$2
  update_available=$3
  should_prompt=$4
  latest_version=$5
  urgent=$6
  error_message=$7

  if [ "$JSON_OUTPUT" -eq 1 ]; then
    printf '{\n'
    if [ -n "$error_message" ]; then
      printf '  "ok": false,\n'
    else
      printf '  "ok": true,\n'
    fi
    printf '  "checked": %s,\n' "$(json_bool_word "$checked")"
    printf '  "skipped": %s,\n' "$(json_bool_word "$skipped")"
    printf '  "updateAvailable": %s,\n' "$(json_bool_word "$update_available")"
    printf '  "shouldPrompt": %s,\n' "$(json_bool_word "$should_prompt")"
    printf '  "installedVersion": "%s",\n' "$(json_escape "$(receipt_value version unknown)")"
    printf '  "latestVersion": "%s",\n' "$(json_escape "$latest_version")"
    printf '  "urgent": %s,\n' "$(json_bool_word "$urgent")"
    printf '  "checkIntervalSeconds": %s,\n' "$(update_check_interval_seconds)"
    printf '  "manifest": "%s"' "$(json_escape "$(manifest_url)")"
    if [ -n "$error_message" ]; then
      printf ',\n  "error": "%s"\n' "$(json_escape "$error_message")"
    else
      printf '\n'
    fi
    printf '}\n'
    return
  fi

  if [ -n "$error_message" ]; then
    printf 'Miles update check skipped: %s\n' "$error_message"
    return
  fi

  if [ "$skipped" = true ]; then
    printf 'Miles update check skipped; last check is still fresh.\n'
    return
  fi

  if [ "$update_available" = true ]; then
    printf 'Miles skill update available: %s -> %s\n' "$(receipt_value version unknown)" "$latest_version"
  else
    printf 'Miles skill is up to date.\n'
  fi
}

install_from_source() {
  source_dir=$1
  parents_file=$2
  agent=$3
  tmp_dir=$4
  version=$(source_version "$source_dir")
  launcher_target=$(primary_launcher_target_from_file "$parents_file")
  runtime_target=$(install_runtime_binary "$source_dir" "$tmp_dir")

  if [ -z "$runtime_target" ] && ! node_ok; then
    fail "No bundled Miles CLI runtime is available for this platform, and Node.js 20+ was not found for the JavaScript fallback"
  fi

  while IFS= read -r parent_dir; do
    [ -n "$parent_dir" ] || continue
    install_skill "$source_dir/miles" "$parent_dir" "$version" "$agent"
  done <"$parents_file"

  install_launcher "$runtime_target" "$launcher_target"
  install_manager "$source_dir/install.sh"
  write_receipt "$parents_file" "$launcher_target" "$runtime_target" "$source_dir" "$agent"
  write_update_cache "$version" "$version" false false
  printf '%s\n' "$(now_epoch)" >"$(update_last_check_file)"
}

install_skill() {
  skill_source=$1
  parent_dir=$2
  version=$3
  agent=$4
  dest_dir="$parent_dir/miles"
  tmp_dest="$parent_dir/.miles.tmp.$$"
  old_dest="$parent_dir/.miles.previous.$$"

  mkdir -p "$parent_dir"
  rm -rf "$tmp_dest" "$old_dest"
  mkdir -p "$tmp_dest"

  copy_dir "$skill_source" "$tmp_dest"
  write_skill_marker "$tmp_dest" "$version" "$agent"

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

install_launcher() {
  runtime_target=$1
  fallback_target=$2
  bin_dir="$HOME/.miles/bin"
  launcher="$bin_dir/miles"
  skill_dir=$(dirname "$(dirname "$fallback_target")")

  mkdir -p "$bin_dir"

  cat >"$launcher" <<EOF
#!/bin/sh
set -eu

RUNTIME="$runtime_target"
FALLBACK="$fallback_target"
SKILL_DIR="$skill_dir"

if [ -n "\$RUNTIME" ] && [ -x "\$RUNTIME" ]; then
  MILES_SKILL_DIR="\${MILES_SKILL_DIR:-\$SKILL_DIR}" \\
  MILES_CLI="\${MILES_CLI:-$launcher}" \\
  exec "\$RUNTIME" "\$@"
fi

MILES_SKILL_DIR="\${MILES_SKILL_DIR:-\$SKILL_DIR}" \\
MILES_CLI="\${MILES_CLI:-$launcher}" \\
exec "\$FALLBACK" "\$@"
EOF

  chmod 755 "$launcher" 2>/dev/null || true
}

install_runtime_binary() {
  source_dir=$1
  tmp_dir=$2

  if [ -n "${MILES_INSTALL_SOURCE_DIR:-}" ] && [ -z "${MILES_CLI_BINARY_URL:-}" ]; then
    return
  fi

  manifest_file=$(runtime_manifest_file "$source_dir" "$tmp_dir")
  platform=$(runtime_platform_key || true)

  if [ -z "$platform" ]; then
    return
  fi

  url=$(manifest_cli_binary_url "$manifest_file" "$platform")
  sha256=$(manifest_cli_binary_sha256 "$manifest_file" "$platform")

  if [ -z "$url" ] || [ -z "$sha256" ]; then
    return
  fi

  tmp_runtime="$tmp_dir/miles-runtime"
  log "Downloading bundled Miles CLI runtime for $platform"
  download_file "$url" "$tmp_runtime"
  verify_file_sha256 "$tmp_runtime" "$sha256" "Miles CLI runtime"

  mkdir -p "$HOME/.miles/bin"
  runtime_target=$(runtime_binary_path)
  cp "$tmp_runtime" "$runtime_target.$$"
  chmod 755 "$runtime_target.$$" 2>/dev/null || true
  mv "$runtime_target.$$" "$runtime_target"
  log "Installed bundled Miles CLI runtime at $runtime_target"
  printf '%s\n' "$runtime_target"
}

install_manager() {
  installer_source=$1

  if [ ! -f "$installer_source" ]; then
    fail "Could not find lifecycle installer at $installer_source"
  fi

  mkdir -p "$(install_dir)" "$HOME/.miles/bin"
  tmp_installer="$(installer_copy).$$"
  cp "$installer_source" "$tmp_installer"
  chmod 755 "$tmp_installer" 2>/dev/null || true
  mv "$tmp_installer" "$(installer_copy)"

  manager="$HOME/.miles/bin/miles-skill"
  cat >"$manager" <<'EOF'
#!/bin/sh
set -eu

INSTALLER="${MILES_SKILL_INSTALLER:-$HOME/.miles/install/install.sh}"

if [ ! -f "$INSTALLER" ]; then
  echo "Miles skill manager is missing: $INSTALLER" >&2
  exit 1
fi

cmd="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  status | check-update | update | uninstall)
    exec sh "$INSTALLER" "--$cmd" "$@"
    ;;
  install)
    exec sh "$INSTALLER" "$@"
    ;;
  -h | --help | help)
    exec sh "$INSTALLER" --help
    ;;
  --*)
    exec sh "$INSTALLER" "$cmd" "$@"
    ;;
  *)
    echo "Unknown Miles skill command: $cmd" >&2
    echo "Use: miles-skill status|check-update|update|uninstall" >&2
    exit 1
    ;;
esac
EOF
  chmod 755 "$manager" 2>/dev/null || true
}

write_receipt() {
  parents_file=$1
  launcher_target=$2
  runtime_target=$3
  source_dir=$4
  agent=$5
  version=$(source_version "$source_dir")

  mkdir -p "$(install_dir)"
  if [ "$parents_file" != "$(destinations_file)" ]; then
    cp "$parents_file" "$(destinations_file)"
  fi

  tmp_receipt="$(receipt_file).$$"
  {
    printf '{\n'
    printf '  "name": "miles",\n'
    printf '  "version": "%s",\n' "$(json_escape "$version")"
    printf '  "agent": "%s",\n' "$(json_escape "$agent")"
    printf '  "installerVersion": "%s",\n' "$(json_escape "$INSTALLER_VERSION")"
    printf '  "source": "%s",\n' "$(json_escape "$(source_archive_url "$source_dir")")"
    source_sha256=$(source_archive_sha256 "$source_dir")
    if [ -n "$source_sha256" ]; then
      printf '  "sourceSha256": "%s",\n' "$(json_escape "$source_sha256")"
    else
      printf '  "sourceSha256": null,\n'
    fi
    printf '  "manifest": "%s",\n' "$(json_escape "$(manifest_url)")"
    printf '  "installedAt": "%s",\n' "$(json_escape "$(now_iso)")"
    printf '  "updateCheckIntervalSeconds": %s,\n' "$(update_check_interval_seconds)"
    printf '  "destinations": [\n'
    print_destinations_json_from_file "$parents_file"
    printf '\n  ],\n'
    printf '  "launchers": {\n'
    printf '    "miles": "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles")")"
    printf '    "milesTarget": "%s",\n' "$(json_escape "$(display_path "$launcher_target")")"
    printf '    "milesSkill": "%s",\n' "$(json_escape "$(display_path "$HOME/.miles/bin/miles-skill")")"
    if [ -n "$runtime_target" ]; then
      printf '    "runtime": "%s"\n' "$(json_escape "$(display_path "$runtime_target")")"
    else
      printf '    "runtime": null\n'
    fi
    printf '  }\n'
    printf '}\n'
  } >"$tmp_receipt"
  mv "$tmp_receipt" "$(receipt_file)"
}

write_skill_marker() {
  marker_dest_dir=$1
  marker_version=$2
  marker_agent=$3

  cat >"$marker_dest_dir/.miles-install" <<EOF
managed_by=miles-skill
version=$marker_version
agent=$marker_agent
installed_at=$(now_iso)
EOF
}

write_update_cache() {
  installed_version=$1
  latest_version=$2
  update_available=$3
  urgent=$4

  mkdir -p "$(install_dir)"
  tmp_cache="$(update_cache_file).$$"
  {
    printf '{\n'
    printf '  "checkedAt": "%s",\n' "$(json_escape "$(now_iso)")"
    printf '  "checkedAtEpoch": %s,\n' "$(now_epoch)"
    printf '  "installedVersion": "%s",\n' "$(json_escape "$installed_version")"
    printf '  "latestVersion": "%s",\n' "$(json_escape "$latest_version")"
    printf '  "updateAvailable": %s,\n' "$(json_bool_word "$update_available")"
    printf '  "urgent": %s\n' "$(json_bool_word "$urgent")"
    printf '}\n'
  } >"$tmp_cache"
  mv "$tmp_cache" "$(update_cache_file)"
}

resolve_source_dir() {
  tmp_dir=$1
  source_dir=${MILES_INSTALL_SOURCE_DIR:-}
  if [ -n "$source_dir" ]; then
    source_dir=$(cd "$source_dir" && pwd)
  else
    source_dir=$(download_source "$tmp_dir")
  fi
  printf '%s\n' "$source_dir"
}

download_source() {
  tmp_dir=$1
  archive_path="$tmp_dir/skills.tar.gz"
  manifest_file="$tmp_dir/version.json"
  source_url=$(archive_url)
  source_sha256=''

  if ! try_download_file "$(manifest_url)" "$manifest_file"; then
    fail "Could not fetch Miles install manifest from $(manifest_url)"
  fi

  source_url=$(manifest_source_url "$manifest_file")
  source_sha256=$(manifest_source_sha256 "$manifest_file")

  log "Downloading Miles skill from $source_url"
  download_file "$source_url" "$archive_path"
  verify_file_sha256 "$archive_path" "$source_sha256" "Miles source archive"

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

  if try_download_file "$url" "$output"; then
    return
  fi

  fail "Install needs curl or wget to download the Miles skill"
}

verify_file_sha256() {
  file=$1
  expected=$2
  label=${3:-file}

  if [ -z "$expected" ]; then
    return
  fi

  actual=$(file_sha256 "$file" 2>/dev/null || true)
  if [ -z "$actual" ]; then
    fail "Install needs shasum, sha256sum, or openssl to verify the Miles source archive"
  fi

  if [ "$actual" != "$expected" ]; then
    fail "$label checksum mismatch. Expected $expected but got $actual"
  fi

  log "Verified $label SHA-256: $actual"
}

file_sha256() {
  file=$1

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
    return
  fi

  return 1
}

try_download_file() {
  url=$1
  output=$2

  case "$url" in
    file://*)
      source_path=${url#file://}
      if [ -f "$source_path" ]; then
        cp "$source_path" "$output"
        return 0
      fi
      return 1
      ;;
    /* | ./* | ../*)
      if [ -f "$url" ]; then
        cp "$url" "$output"
        return 0
      fi
      ;;
  esac

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return $?
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
    return $?
  fi

  return 1
}

require_skill_source() {
  source_dir=$1
  if [ ! -f "$source_dir/miles/SKILL.md" ]; then
    fail "Could not find miles/SKILL.md in $source_dir"
  fi
  if [ ! -f "$source_dir/install.sh" ]; then
    fail "Could not find install.sh in $source_dir"
  fi
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

archive_url() {
  repo_url=${MILES_SKILLS_REPO:-https://github.com/bymilesai/skills}
  ref=${MILES_SKILLS_REF:-trunk}
  printf '%s\n' "${MILES_SKILLS_ARCHIVE_URL:-$repo_url/archive/refs/heads/$ref.tar.gz}"
}

manifest_url() {
  printf '%s\n' "${MILES_SKILL_MANIFEST_URL:-https://raw.githubusercontent.com/bymilesai/skills/trunk/version.json}"
}

payload_manifest_url() {
  printf '%s\n' "${MILES_SKILL_PAYLOAD_MANIFEST_URL:-https://raw.githubusercontent.com/bymilesai/skills/trunk/payload-manifest.json}"
}

manifest_file_for_read() {
  tmp_dir=$1
  source_dir=${MILES_INSTALL_SOURCE_DIR:-}

  if [ -n "$source_dir" ] && [ -f "$source_dir/version.json" ]; then
    printf '%s\n' "$source_dir/version.json"
    return 0
  fi

  output="$tmp_dir/version.json"
  if try_download_file "$(manifest_url)" "$output"; then
    printf '%s\n' "$output"
    return 0
  fi

  return 1
}

payload_manifest_file_for_read() {
  tmp_dir=$1
  url=$2
  source_dir=${MILES_INSTALL_SOURCE_DIR:-}

  if [ -n "$source_dir" ] && [ -f "$source_dir/payload-manifest.json" ]; then
    printf '%s\n' "$source_dir/payload-manifest.json"
    return 0
  fi

  output="$tmp_dir/payload-manifest.json"
  if try_download_file "$url" "$output"; then
    printf '%s\n' "$output"
    return 0
  fi

  return 1
}

manifest_source_url() {
  manifest_file=$1
  if [ -n "${MILES_SKILLS_ARCHIVE_URL:-}" ]; then
    archive_url
    return
  fi

  value=$(json_value_file "$manifest_file" source)
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return
  fi

  archive_url
}

manifest_source_sha256() {
  manifest_file=$1
  if [ -n "${MILES_SKILLS_SOURCE_SHA256:-}" ]; then
    printf '%s\n' "$MILES_SKILLS_SOURCE_SHA256"
    return
  fi

  if [ -n "${MILES_SKILLS_ARCHIVE_URL:-}" ]; then
    return
  fi

  json_value_file "$manifest_file" sourceSha256
}

manifest_payload_manifest_url() {
  manifest_file=$1
  value=$(json_value_file "$manifest_file" payloadManifest)
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return
  fi

  payload_manifest_url
}

runtime_manifest_file() {
  source_dir=$1
  tmp_dir=$2

  if [ -f "$tmp_dir/version.json" ]; then
    printf '%s\n' "$tmp_dir/version.json"
    return
  fi

  if [ -f "$source_dir/version.json" ]; then
    printf '%s\n' "$source_dir/version.json"
    return
  fi

  printf '\n'
}

runtime_platform_key() {
  system=$(uname -s 2>/dev/null || printf unknown)
  machine=$(uname -m 2>/dev/null || printf unknown)

  case "$system" in
    Darwin)
      os=darwin
      ;;
    Linux)
      os=linux
      ;;
    MINGW* | MSYS* | CYGWIN*)
      os=windows
      ;;
    *)
      return
      ;;
  esac

  case "$machine" in
    arm64 | aarch64)
      arch=arm64
      ;;
    x86_64 | amd64)
      arch=x64
      ;;
    *)
      return
      ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

runtime_binary_path() {
  printf '%s\n' "$HOME/.miles/bin/miles-runtime"
}

runtime_status_text() {
  manifest_file=$1
  platform=$(runtime_platform_key || true)

  if [ -z "$platform" ]; then
    printf 'not available for this platform; JavaScript fallback will be used\n'
    return
  fi

  url=$(manifest_cli_binary_url "$manifest_file" "$platform")
  sha256=$(manifest_cli_binary_sha256 "$manifest_file" "$platform")

  if [ -n "$url" ] && [ -n "$sha256" ]; then
    printf 'available for %s with SHA-256 verification\n' "$platform"
  elif [ -n "$url" ]; then
    printf 'listed for %s but not checksum-pinned yet; JavaScript fallback will be used\n' "$platform"
  else
    printf 'not listed for %s; JavaScript fallback will be used\n' "$platform"
  fi
}

manifest_cli_binary_url() {
  manifest_file=$1
  platform=$2

  if [ -n "${MILES_CLI_BINARY_URL:-}" ]; then
    printf '%s\n' "$MILES_CLI_BINARY_URL"
    return
  fi

  if [ -z "$manifest_file" ] || [ ! -f "$manifest_file" ]; then
    return
  fi

  sed -n "/\"$platform\"[[:space:]]*:/,/^[[:space:]]*}[,]*[[:space:]]*$/p" "$manifest_file" |
    sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    sed -n '1p'
}

manifest_cli_binary_sha256() {
  manifest_file=$1
  platform=$2

  if [ -n "${MILES_CLI_BINARY_SHA256:-}" ]; then
    printf '%s\n' "$MILES_CLI_BINARY_SHA256"
    return
  fi

  if [ -z "$manifest_file" ] || [ ! -f "$manifest_file" ]; then
    return
  fi

  sed -n "/\"$platform\"[[:space:]]*:/,/^[[:space:]]*}[,]*[[:space:]]*$/p" "$manifest_file" |
    sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    sed -n '1p'
}

print_runtime_plan_json() {
  manifest_file=$1
  platform=$(runtime_platform_key || true)
  url=''
  sha256=''

  if [ -n "$platform" ]; then
    url=$(manifest_cli_binary_url "$manifest_file" "$platform")
    sha256=$(manifest_cli_binary_sha256 "$manifest_file" "$platform")
  fi

  printf '{\n'
  if [ -n "$platform" ]; then
    printf '      "platform": "%s",\n' "$(json_escape "$platform")"
  else
    printf '      "platform": null,\n'
  fi
  printf '      "path": "%s",\n' "$(json_escape "$(display_path "$(runtime_binary_path)")")"
  if [ -n "$url" ]; then
    printf '      "url": "%s",\n' "$(json_escape "$url")"
  else
    printf '      "url": null,\n'
  fi
  if [ -n "$sha256" ]; then
    printf '      "sha256": "%s",\n' "$(json_escape "$sha256")"
    printf '      "willInstall": true\n'
  else
    printf '      "sha256": null,\n'
    printf '      "willInstall": false\n'
  fi
  printf '    }'
}

source_archive_url() {
  source_dir=$1
  manifest_file="$source_dir/version.json"
  if [ -f "$manifest_file" ]; then
    manifest_source_url "$manifest_file"
    return
  fi
  archive_url
}

source_archive_sha256() {
  source_dir=$1
  manifest_file="$source_dir/version.json"
  if [ -f "$manifest_file" ]; then
    manifest_source_sha256 "$manifest_file"
  fi
}

sha256_status_text() {
  expected=$1
  if [ -n "$expected" ]; then
    printf '%s\n' "$expected"
  else
    printf 'not published in this manifest\n'
  fi
}

install_dir() {
  printf '%s\n' "$HOME/.miles/install"
}

receipt_file() {
  printf '%s\n' "$(install_dir)/receipt.json"
}

destinations_file() {
  printf '%s\n' "$(install_dir)/destinations.txt"
}

update_cache_file() {
  printf '%s\n' "$(install_dir)/update-cache.json"
}

update_last_check_file() {
  printf '%s\n' "$(install_dir)/last-update-check"
}

installer_copy() {
  printf '%s\n' "$(install_dir)/install.sh"
}

update_check_interval_seconds() {
  printf '%s\n' "${MILES_UPDATE_CHECK_INTERVAL_SECONDS:-$DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS}"
}

destination_parent_dirs() {
  case "$AGENT" in
    all)
      all_known_destination_parent_dirs
      ;;
    shared | codex | cursor | opencode)
      printf '%s\n' "$HOME/.agents/skills"
      ;;
    claude)
      printf '%s\n' "$HOME/.claude/skills"
      ;;
  esac
}

all_known_destination_parent_dirs() {
  # Follow the Vercel skills CLI grouping: Codex, Cursor, OpenCode,
  # and other universal agents share .agents/skills. Claude Code uses
  # its dedicated global skill directory.
  printf '%s\n' \
    "$HOME/.agents/skills" \
    "$HOME/.claude/skills"
}

status_parent_dirs() {
  if [ -f "$(destinations_file)" ]; then
    cat "$(destinations_file)"
  else
    all_known_destination_parent_dirs
  fi
}

uninstall_parent_dirs() {
  status_parent_dirs
}

primary_launcher_target() {
  case "$AGENT" in
    all | shared | codex | cursor | opencode)
      printf '%s\n' "$HOME/.agents/skills/miles/scripts/miles"
      ;;
    claude)
      printf '%s\n' "$HOME/.claude/skills/miles/scripts/miles"
      ;;
  esac
}

primary_launcher_target_from_file() {
  parents_file=$1
  parent_dir=$(sed -n '1p' "$parents_file")
  if [ -z "$parent_dir" ]; then
    fail "No destination directories selected"
  fi
  printf '%s\n' "$parent_dir/miles/scripts/miles"
}

source_version() {
  source_dir=$1
  manifest="$source_dir/version.json"
  if [ -f "$manifest" ]; then
    version=$(json_value_file "$manifest" version)
    if [ -n "$version" ]; then
      printf '%s\n' "$version"
      return
    fi
  fi
  printf '%s\n' "$INSTALLER_VERSION"
}

receipt_value() {
  key=$1
  fallback=$2
  if [ -f "$(receipt_file)" ]; then
    value=$(json_value_file "$(receipt_file)" "$key")
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return
    fi
  fi
  printf '%s\n' "$fallback"
}

cache_value() {
  key=$1
  fallback=$2
  if [ -f "$(update_cache_file)" ]; then
    value=$(json_value_file "$(update_cache_file)" "$key")
    if [ -z "$value" ]; then
      value=$(json_raw_file "$(update_cache_file)" "$key")
    fi
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return
    fi
  fi
  printf '%s\n' "$fallback"
}

json_value_file() {
  file=$1
  key=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | sed -n '1p'
}

json_raw_file() {
  file=$1
  key=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\([^,} ]*\).*/\1/p" "$file" | sed -n '1p'
}

json_bool_file() {
  file=$1
  key=$2
  fallback=$3
  value=$(json_raw_file "$file" "$key")
  case "$value" in
    true | false)
      printf '%s\n' "$value"
      ;;
    *)
      printf '%s\n' "$fallback"
      ;;
  esac
}

print_destinations_json_from_stream() {
  stream_fn=$1
  first=1
  $stream_fn | while IFS= read -r parent_dir; do
    [ -n "$parent_dir" ] || continue
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
}

print_destinations_json_from_file() {
  parents_file=$1
  first=1
  while IFS= read -r parent_dir; do
    [ -n "$parent_dir" ] || continue
    dest_dir="$parent_dir/miles"
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ',\n'
    fi
    printf '    { "path": "%s", "exists": %s }' \
      "$(json_escape "$(display_path "$dest_dir")")" \
      "$(json_bool_exists "$dest_dir")"
  done <"$parents_file"
}

print_uninstall_destinations_json_from_stream() {
  stream_fn=$1
  first=1
  $stream_fn | while IFS= read -r parent_dir; do
    [ -n "$parent_dir" ] || continue
    dest_dir="$parent_dir/miles"
    owned=false
    will_remove=false
    if is_miles_owned_skill_dir "$dest_dir"; then
      owned=true
      will_remove=true
    fi
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ',\n'
    fi
    printf '    { "path": "%s", "exists": %s, "owned": %s, "willRemove": %s }' \
      "$(json_escape "$(display_path "$dest_dir")")" \
      "$(json_bool_exists "$dest_dir")" \
      "$owned" \
      "$will_remove"
  done
}

print_payload_summary() {
  tmp_dir=$1
  manifest=$2

  if payload_file=$(payload_manifest_file_for_read "$tmp_dir" "$manifest"); then
    root=$(json_value_file "$payload_file" root)
    file_count=$(json_raw_file "$payload_file" fileCount)
    total_bytes=$(json_raw_file "$payload_file" totalBytes)

    printf '  Root: %s\n' "${root:-unknown}"
    printf '  Files: %s\n' "${file_count:-unknown}"
    printf '  Total bytes: %s\n' "${total_bytes:-unknown}"
    printf '  Included files:\n'
    sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/    - \1/p' "$payload_file"
    return
  fi

  printf '  Manifest unavailable; payload contents were not inspected.\n'
}

print_payload_json() {
  tmp_dir=$1
  manifest=$2

  if payload_file=$(payload_manifest_file_for_read "$tmp_dir" "$manifest"); then
    cat "$payload_file"
    return
  fi

  printf 'null'
}

is_miles_owned_skill_dir() {
  dest_dir=$1
  if [ -f "$dest_dir/.miles-install" ]; then
    return 0
  fi
  if [ -f "$dest_dir/SKILL.md" ] && grep -q '^name:[[:space:]]*miles' "$dest_dir/SKILL.md"; then
    return 0
  fi
  return 1
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

node_ok() {
  [ "$(node_ok_json)" = true ]
}

last_update_check_epoch_json() {
  if [ -f "$(update_last_check_file)" ]; then
    value=$(cat "$(update_last_check_file)" 2>/dev/null || true)
    if is_integer "$value"; then
      printf '%s\n' "$value"
      return
    fi
  fi
  printf 'null\n'
}

exists_status() {
  if [ -e "$1" ]; then
    printf 'exists\n'
  else
    printf 'will create\n'
  fi
}

purge_status_text() {
  if [ "$PURGE" -eq 1 ]; then
    printf '(will remove)\n'
  else
    printf '(will keep)\n'
  fi
}

json_bool_exists() {
  if [ -e "$1" ]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

json_bool() {
  if [ "$1" -eq 1 ]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

json_bool_word() {
  case "$1" in
    true | 1)
      printf 'true\n'
      ;;
    *)
      printf 'false\n'
      ;;
  esac
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

is_integer() {
  case "$1" in
    '' | *[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

make_tmp_dir() {
  mktemp -d "${TMPDIR:-/tmp}/miles-install.XXXXXX"
}

now_epoch() {
  date +%s
}

now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Miles skill %s failed: %s\n' "$ACTION" "$*" >&2
  exit 1
}

main "$@"
