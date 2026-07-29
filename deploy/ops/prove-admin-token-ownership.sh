#!/bin/sh
set -eu
umask 077

stage=input
claimed=0
project=
claim_directory=

compose_yaml() {
  cat <<'YAML'
services:
  tf-api:
    image: ${APOLLO_TF_API_IMAGE:?}
    pull_policy: never
    user: "10001:10001"
    read_only: true
    network_mode: none
    entrypoint:
      - node
      - -e
      - |
        const fs = require("node:fs");
        const value = fs.readFileSync("/run/secrets/admin_dashboard_token", "utf8");
        const bytes = Buffer.byteLength(value);
        if (bytes < 32 || bytes > 4096 || value.includes("\n") || value.includes("\r")) {
          process.exit(1);
        }
    secrets:
      - source: admin_dashboard_token
        target: admin_dashboard_token
        uid: "10001"
        gid: "10001"
        mode: "0400"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
  tf-admin:
    image: ${APOLLO_TF_ADMIN_IMAGE:?}
    pull_policy: never
    user: "0:0"
    read_only: true
    network_mode: none
    entrypoint:
      - /bin/sh
      - -eu
      - -c
      - |
        file=/run/secrets/admin_dashboard_token
        test -f "$$file" && test -r "$$file"
        size="$$(wc -c < "$$file")"
        case "$$size" in ""|*[!0-9]*) exit 1 ;; esac
        test "$$size" -ge 32 && test "$$size" -le 4096
        ! grep -q "$$(printf '\r')" "$$file"
        test "$$(wc -l < "$$file" | tr -d ' ')" = 0
    secrets:
      - source: admin_dashboard_token
        target: admin_dashboard_token
        uid: "10001"
        gid: "10001"
        mode: "0400"
    security_opt:
      - no-new-privileges:true
secrets:
  admin_dashboard_token:
    file: ${APOLLO_ADMIN_DASHBOARD_TOKEN_FILE:?}
YAML
}

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$claimed" -eq 1 ]; then
    if ! compose_yaml |
      docker compose -f - -p "$project" down --remove-orphans \
        >/dev/null 2>&1; then
      result=1
    fi
    if ! rmdir "$claim_directory" >/dev/null 2>&1; then
      result=1
    fi
  fi
  if [ "$result" -ne 0 ]; then
    printf 'native-admin-token-proof: %s failed\n' "$stage" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

require_value() {
  eval "value=\${$1-}"
  [ -n "$value" ]
}

safe_identifier() {
  case "$1" in
    [A-Za-z0-9]*)
      case "$1" in *[!A-Za-z0-9_-]*) return 1 ;; esac
      ;;
    *) return 1 ;;
  esac
  [ "${#1}" -le 40 ]
}

immutable_image() {
  printf '%s\n' "$1" |
    grep -Eq '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
}

if [ "$#" -ne 0 ] ||
  ! require_value APOLLO_ADMIN_DASHBOARD_TOKEN_FILE ||
  ! require_value APOLLO_TF_API_IMAGE ||
  ! require_value APOLLO_TF_ADMIN_IMAGE ||
  ! require_value APOLLO_NATIVE_PROOF_ID; then
  exit 1
fi

safe_identifier "$APOLLO_NATIVE_PROOF_ID" || exit 1
immutable_image "$APOLLO_TF_API_IMAGE" || exit 1
immutable_image "$APOLLO_TF_ADMIN_IMAGE" || exit 1
case "$APOLLO_ADMIN_DASHBOARD_TOKEN_FILE" in /*) ;; *) exit 1 ;; esac

lock_parent=${APOLLO_NATIVE_PROOF_LOCK_PARENT:-/run/lock}
[ -d "$lock_parent" ] && [ -w "$lock_parent" ] || exit 1
project="apollo-admin-token-proof-$APOLLO_NATIVE_PROOF_ID"
claim_directory="${lock_parent%/}/$project"

stage=claim
mkdir "$claim_directory" 2>/dev/null || exit 1
claimed=1
existing="$(
  docker ps -aq --filter "label=com.docker.compose.project=$project" \
    2>/dev/null
)" || exit 1
[ -z "$existing" ] || exit 1

stage=metadata
token_parent=${APOLLO_ADMIN_DASHBOARD_TOKEN_FILE%/*}
token_name=${APOLLO_ADMIN_DASHBOARD_TOKEN_FILE##*/}
[ -n "$token_parent" ] && [ "$token_name" = admin_dashboard_token ] || exit 1
[ -d "$token_parent" ] || exit 1
expected_metadata="10001:10001:400"
actual_metadata="$(
  cd -P -- "$token_parent" &&
    stat -c '%u:%g:%a' -- "$token_name" 2>/dev/null
)" || exit 1
[ "$actual_metadata" = "$expected_metadata" ] || exit 1

stage=tf-api
compose_yaml |
  docker compose -f - -p "$project" run --rm --no-deps tf-api \
    >/dev/null 2>&1 ||
  exit 1

stage=tf-admin
compose_yaml |
  docker compose -f - -p "$project" run --rm --no-deps tf-admin \
    >/dev/null 2>&1 ||
  exit 1

stage=complete
printf 'native-admin-token-proof: complete\n'
