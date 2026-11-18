#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/local-test.sh portable | scratch WORKTREE -- COMMAND [ARG ...]" >&2
  exit 2
}

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
repo=$(git --git-dir="$common" worktree list --porcelain | sed -n '1s/^worktree //p')
mode=${1:-}
case "$mode" in
  portable)
    [[ $# == 1 ]] || usage
    ;;
  scratch)
    [[ $# -ge 4 && $3 == -- ]] || usage
    checkout=$(cd -- "$2" && pwd -P)
    shift 3
    if [[ "$checkout" != "$repo/.harbor/"* || "$checkout" == "$repo/.harbor/live-worktree" ||
      $(git -C "$checkout" rev-parse --show-toplevel) != "$checkout" ||
      $(git -C "$checkout" rev-parse --path-format=absolute --git-common-dir) != "$common" ]]; then
      echo "Choose a separate Harbor test worktree under .harbor." >&2
      exit 2
    fi
    ;;
  *) usage ;;
esac

evidence="$repo/.harbor/test-logs"
mkdir -p -- "$evidence"
log=$(mktemp "$evidence/$mode.XXXXXXXX")
echo "Test evidence: $log"

trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$mode" == scratch ]]; then
  cd -- "$checkout"
  lock=.harbor-test-running
  if ! mkdir -- "$lock"; then
    echo "This worktree already has a test lock." >&2
    exit 1
  fi
  clean_dependencies=false
  # Invoked by the EXIT trap.
  # shellcheck disable=SC2329
  cleanup_scratch() {
    local status=$?
    trap - EXIT
    if "$clean_dependencies"; then
      rm -rf -- node_modules || { [[ $status != 0 ]] || status=1; }
      if [[ ! -L tests && ! -L tests/portable-fixtures ]]; then
        rm -rf -- tests/portable-fixtures/node_modules || { [[ $status != 0 ]] || status=1; }
      fi
    fi
    rmdir -- "$lock" || { [[ $status != 0 ]] || status=1; }
    exit "$status"
  }
  trap cleanup_scratch EXIT
  for dependency in node_modules tests/portable-fixtures/node_modules; do
    if [[ -e "$dependency" || -L "$dependency" ]] || ! git check-ignore -q -- "$dependency/"; then
      echo "Choose a fresh test worktree without $dependency." >&2
      exit 2
    fi
  done
  if [[ -L tests || -L tests/portable-fixtures ]]; then
    echo "Test fixture paths must be inside the test worktree." >&2
    exit 2
  fi
  clean_dependencies=true
  npm run install:ci 2>&1 | tee -a "$log"
  "$@" 2>&1 | tee -a "$log"
  exit
fi

cd -- "$root"
context=$(docker context show)
dock=(docker --context "$context")
endpoint=$("${dock[@]}" context inspect "$context" --format '{{.Endpoints.docker.Host}}')
if [[ "$endpoint" != unix://* ]]; then
  echo "Portable tests require a local Docker context." >&2
  exit 2
fi
builder="harbor-local-tests-$(printf '%s' "$context" | cksum | cut -d' ' -f1)"
if ! "${dock[@]}" buildx inspect "$builder" >/dev/null 2>&1; then
  "${dock[@]}" buildx create --name "$builder" --driver docker-container "$context" ||
    "${dock[@]}" buildx inspect "$builder" >/dev/null
fi
run_name="harbor-local-test-${log##*.}"
image="harbor-local-test:$run_name"
cleanup_docker() {
  local status=$?
  trap - EXIT
  if "${dock[@]}" container inspect "$run_name" >/dev/null 2>&1; then
    "${dock[@]}" container rm -f "$run_name" || { [[ $status != 0 ]] || status=1; }
  fi
  if "${dock[@]}" image inspect "$image" >/dev/null 2>&1; then
    "${dock[@]}" image rm "$image" || { [[ $status != 0 ]] || status=1; }
  fi
  "${dock[@]}" buildx prune --builder "$builder" --force --max-used-space 4gb ||
    { [[ $status != 0 ]] || status=1; }
  exit "$status"
}
trap cleanup_docker EXIT
set -- --set "check.tags=$image" --set check.output=type=docker
if [[ -n ${DOCKER_DEFAULT_PLATFORM:-} ]]; then
  set -- "$@" --set "*.platform=$DOCKER_DEFAULT_PLATFORM"
fi
"${dock[@]}" buildx bake --builder "$builder" -f scripts/local-test-bake.hcl "$@" check 2>&1 | tee -a "$log"
"${dock[@]}" run --rm --name "$run_name" --init --network none \
  -e HARBOR_TEST_SUITE_TIMEOUT_MS "$image" 2>&1 | tee -a "$log"
