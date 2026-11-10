#!/usr/bin/env bash
# Load the native-check policy only in an ephemeral GitHub-hosted VM.
set -euo pipefail
[[ $# == 0 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RUNNER_OS:-}" == Linux ]] || {
  echo 'AppArmor setup is restricted to the approved hosted Linux CI job' >&2; exit 2;
}
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ && "${GITHUB_JOB:-}" == backend ]] || exit 2
[[ "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" == ubuntu:24.04 ]] || exit 2
command -v apparmor_parser >/dev/null
[[ -r /sys/module/apparmor/parameters/enabled && "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]] || exit 2
[[ "$(docker info --format '{{json .SecurityOptions}}')" == *name=apparmor* ]] || exit 2

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary=$(mktemp -d "${RUNNER_TEMP:?}/sabre-apparmor.XXXXXXXX")
profile="sabre-codex-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${temporary##*.}"
profile_file="$temporary/profile"
load_attempted=0
loader_pid=''
profile_present() {
  # Return 0 for exact presence, 1 for confirmed absence, 2 when presence is unknown.
  local profiles
  profiles=$(sudo cat /sys/kernel/security/apparmor/profiles) || return 2
  printf '%s\n' "$profiles" | awk -v expected="$profile" '$1 == expected { found=1 } END { exit !found }'
}
cleanup() {
  status=$?
  trap - EXIT
  # Finish any in-flight load before inspecting/removing the profile; subsequent signals
  # cannot make cleanup unload first and let a late loader recreate the policy afterward.
  trap '' INT TERM
  failed=0
  if [[ $load_attempted == 1 ]]; then
    # $! assignment may itself be interrupted after launch; this script has no other background job.
    if [[ -z "$loader_pid" ]]; then loader_pid=$(jobs -p); fi
    if [[ -n "$loader_pid" ]]; then
      if [[ "$loader_pid" =~ ^[0-9]+$ ]]; then wait "$loader_pid" || true
      else failed=1; fi
    fi
    if profile_present; then present=1
    else presence_status=$?; present=0; [[ $presence_status == 1 ]] || failed=1; fi
  else
    present=0
  fi
  if [[ $present == 1 && $failed == 0 ]]; then
    if [[ $status != 0 ]]; then
      sudo journalctl --kernel --no-pager --output=cat --lines=20 --grep="profile=\"$profile\"" || echo 'Scoped AppArmor diagnostics unavailable' >&2
    fi
    # This label is set by the harness together with the exact AppArmor selector.
    ids=$(docker ps -aq --filter "label=sabre.apparmor_profile=$profile") || failed=1
    for id in ${ids:-}; do
      metadata=$(docker inspect --format '{{index .Config.Labels "sabre.owner"}}|{{index .Config.Labels "sabre.kind"}}|{{index .Config.Labels "sabre.apparmor_profile"}}|{{.AppArmorProfile}}' "$id") || { failed=1; continue; }
      if [[ "$metadata" != "rebuild|development-check|$profile|$profile" ]]; then
        echo 'Refusing to remove an unowned profile consumer' >&2; failed=1; continue
      fi
      running=$(docker inspect --format '{{.State.Running}}' "$id") || { failed=1; continue; }
      if [[ "$running" == true ]]; then docker stop --time 5 "$id" >/dev/null || { failed=1; continue; }; fi
      docker rm "$id" >/dev/null || failed=1
    done
    # Never unload a policy still selected by another container, including stopped containers.
    ids=$(docker ps -aq) || failed=1
    for id in ${ids:-}; do
      selected=$(docker inspect --format '{{.AppArmorProfile}}' "$id") || { failed=1; continue; }
      if [[ "$selected" == "$profile" ]]; then failed=1; fi
    done
    if [[ $failed == 0 ]]; then
      sudo apparmor_parser --remove --skip-cache "$profile_file" || failed=1
      if profile_present; then failed=1
      else presence_status=$?; [[ $presence_status == 1 ]] || failed=1; fi
    fi
  fi
  if [[ $failed == 0 ]]; then
    if [[ -f "$profile_file" ]]; then rm -- "$profile_file" || failed=1; fi
    rmdir -- "$temporary" || failed=1
  else
    echo 'Cleanup incomplete; preserving the exact policy file for removal. The hosted VM must be retired.' >&2
  fi
  if [[ $status == 0 && $failed != 0 ]]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sed "s/@@SABRE_APPARMOR_PROFILE@@/$profile/g" "$root/infra/codex-apparmor.profile.in" > "$profile_file"
# Validation only first; never replace docker-default or any existing named policy.
apparmor_parser --skip-kernel-load --skip-cache "$profile_file"
if profile_present; then echo 'Refusing to replace an existing AppArmor profile' >&2; exit 2
else presence_status=$?; [[ $presence_status == 1 ]] || exit 2; fi
load_attempted=1
# Track the loader so cleanup waits for it even if the wrapper is interrupted during wait.
sudo apparmor_parser --add --skip-cache "$profile_file" &
loader_pid=$!
wait "$loader_pid"
if ! profile_present; then echo 'The new AppArmor profile could not be verified' >&2; exit 2; fi
cd -- "$root"
SABRE_CODEX_APPARMOR_PROFILE="$profile" node infra/dev.mjs codex-policy
