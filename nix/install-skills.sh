# Source this file from the Home Manager activation shell, which supplies run.
install_agent_skills() (
  set -e
  local home_root="$1" state="$2"
  shift 2
  local manifest="$state/links.tsv" backup="" pending=""
  local target source saved
  declare -A previous=() desired=()
  if [ "$#" -eq 0 ] && [ ! -f "$manifest" ]; then
    return 0
  fi
  if [ -f "$manifest" ]; then
    while IFS=$'\t' read -r target source; do
      [ -n "$target" ] || continue
      previous["$target"]="$source"
    done < "$manifest"
  fi
  run mkdir -p "$state"
  install_skill() {
    local target="$1" source="$2" current=""
    desired["$target"]="$source"
    if [ -L "$target" ]; then
      current="$(readlink "$target")"
      [ "$current" != "$source" ] || return 0
    fi
    if [ -e "$target" ] || [ -L "$target" ]; then
      if [ -z "$current" ] || [ "$current" != "${previous[$target]-}" ]; then
        if [[ -v DRY_RUN ]]; then
          echo "would back up $target under $state/backups"
        else
          if [ -z "$backup" ]; then
            mkdir -p "$state/backups"
            backup="$(mktemp -d "$state/backups/activation.XXXXXX")"
          fi
          saved="$backup/${target#"$home_root"/}"
          mkdir -p "$(dirname "$saved")"
          mv "$target" "$saved"
          echo "backed up $target to $saved"
        fi
      fi
    fi
    run mkdir -p "$(dirname "$target")"
    run ln -sfn "$source" "$target"
  }
  while [ "$#" -gt 0 ]; do
    install_skill "$1" "$2"
    shift 2
  done
  for target in "${!previous[@]}"; do
    if [ -z "${desired[$target]+set}" ] && [ -L "$target" ] && \
       [ "$(readlink "$target")" = "${previous[$target]}" ]; then
      run rm "$target"
    fi
  done
  if [[ ! -v DRY_RUN ]]; then
    pending="$(mktemp "$state/links.XXXXXX")"
    trap 'rm -f "$pending"' EXIT
    for target in "${!desired[@]}"; do
      printf '%s\t%s\n' "$target" "${desired[$target]}"
    done | sort > "$pending"
    mv "$pending" "$manifest"
  fi
)
