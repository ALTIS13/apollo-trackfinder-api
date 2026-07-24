#!/bin/sh
set -eu

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE must be configured}"

if [ ! -r "$DATABASE_URL_FILE" ]; then
  exit 1
fi

database_url=$(cat "$DATABASE_URL_FILE")
if [ -z "$database_url" ] || [ "${#database_url}" -gt 4096 ]; then
  unset database_url
  exit 1
fi

export DATABASE_URL="$database_url"
unset database_url

if [ -n "${APOLLO_MODULE_HEARTBEAT_KEYS_FILE:-}" ]; then
  unset APOLLO_MODULE_HEARTBEAT_KEYS
  if [ ! -r "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE" ]; then
    exit 1
  fi

  heartbeat_keys_size=$(wc -c < "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE")
  if [ "$heartbeat_keys_size" -lt 1 ] || [ "$heartbeat_keys_size" -gt 131072 ]; then
    unset heartbeat_keys_size
    exit 1
  fi
  unset heartbeat_keys_size

  heartbeat_keys=$(
    node - "$APOLLO_MODULE_HEARTBEAT_KEYS_FILE" <<'NODE'
const { readFileSync } = require("node:fs");

const allowedModuleIds = new Set([
  "public-web",
  "core-api",
  "account-integrations",
  "search-media",
  "download-worker",
  "postgresql",
  "redis",
  "queue-redis",
  "media-storage",
]);
const fail = () => process.exit(1);

let raw;
let parsed;
try {
  raw = readFileSync(process.argv[2], "utf8");
  parsed = JSON.parse(raw);
} catch {
  fail();
}

if (
  typeof parsed !== "object" ||
  parsed === null ||
  Array.isArray(parsed) ||
  Object.getPrototypeOf(parsed) !== Object.prototype
) {
  fail();
}

const entries = Object.entries(parsed);
if (
  entries.length > 128 ||
  !Object.prototype.hasOwnProperty.call(parsed, "search-media")
) {
  fail();
}
for (const [moduleId, secret] of entries) {
  if (
    !allowedModuleIds.has(moduleId) ||
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 512
  ) {
    fail();
  }
}

process.stdout.write(raw);
NODE
  ) || {
    unset heartbeat_keys
    exit 1
  }

  export APOLLO_MODULE_HEARTBEAT_KEYS="$heartbeat_keys"
  unset heartbeat_keys
fi

exec "$@"
