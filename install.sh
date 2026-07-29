#!/usr/bin/env bash
# Link this repository's skills and agents into ~/.claude.
#
# Symlinks rather than copies, so an edit here is live immediately and the
# working copy can never silently drift from what is committed.
#
#   ./install.sh          link everything
#   ./install.sh --check  report the current link state and exit
#   ./install.sh --unlink remove the links this script created
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MODE="${1:-link}"

skill_dirs() { find "$REPO/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null; }
agent_files() { find "$REPO/agents" -mindepth 1 -maxdepth 1 -name '*.md' 2>/dev/null; }

status_of() {
  local link="$1" target="$2"
  if [ -L "$link" ]; then
    if [ "$(readlink -f "$link")" = "$(readlink -f "$target")" ]; then echo "linked"; else echo "linked-elsewhere"; fi
  elif [ -e "$link" ]; then
    echo "real-file"
  else
    echo "absent"
  fi
}

check() {
  local rc=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    local link="$CLAUDE_DIR/skills/$(basename "$dir")"
    local state; state="$(status_of "$link" "$dir")"
    printf '%-16s skill  %s\n' "$state" "$link"
    [ "$state" = "linked" ] || rc=1
  done < <(skill_dirs)

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    local link="$CLAUDE_DIR/agents/$(basename "$file")"
    local state; state="$(status_of "$link" "$file")"
    printf '%-16s agent  %s\n' "$state" "$link"
    [ "$state" = "linked" ] || rc=1
  done < <(agent_files)

  return $rc
}

backup_then_link() {
  local target="$1" link="$2"
  local state; state="$(status_of "$link" "$target")"

  case "$state" in
    linked) echo "ok       $link"; return 0 ;;
    real-file)
      # Never delete a real file that is not tracked here; move it aside first.
      local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      local backup="$CLAUDE_DIR/backups/install-$stamp"
      mkdir -p "$backup"
      mv "$link" "$backup/"
      echo "backed up  $link -> $backup/"
      ;;
    linked-elsewhere) rm -f "$link" ;;
  esac

  mkdir -p "$(dirname "$link")"
  ln -s "$target" "$link"
  echo "linked   $link -> $target"
}

case "$MODE" in
  --check) check ;;
  --unlink)
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      local_link="$CLAUDE_DIR/skills/$(basename "$dir")"
      [ -L "$local_link" ] && rm -f "$local_link" && echo "unlinked $local_link"
    done < <(skill_dirs)
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      local_link="$CLAUDE_DIR/agents/$(basename "$file")"
      [ -L "$local_link" ] && rm -f "$local_link" && echo "unlinked $local_link"
    done < <(agent_files)
    ;;
  link)
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      backup_then_link "$dir" "$CLAUDE_DIR/skills/$(basename "$dir")"
    done < <(skill_dirs)
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      backup_then_link "$file" "$CLAUDE_DIR/agents/$(basename "$file")"
    done < <(agent_files)
    echo
    echo "Verify discovery with:  /babysit-prs --snapshot-only"
    ;;
  *)
    echo "usage: $0 [--check|--unlink]" >&2
    exit 2
    ;;
esac
