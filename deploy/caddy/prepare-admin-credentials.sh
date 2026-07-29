#!/bin/sh
set -eu
umask 077

stage=input
generation_directory=
claimed=0
completed=0

cleanup() {
  result=$?
  if [ "$completed" -ne 1 ] && [ "$claimed" -eq 1 ]; then
    rm -rf "$generation_directory" >/dev/null 2>&1 || :
  fi
  if [ "$result" -ne 0 ]; then
    printf 'admin-credential-generation: %s failed\n' "$stage" >&2
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

require_value() {
  eval "value=\${$1-}"
  [ -n "$value" ]
}

safe_generation() {
  case "$1" in
    [A-Za-z0-9]*)
      case "$1" in *[!A-Za-z0-9._-]*) return 1 ;; esac
      ;;
    *) return 1 ;;
  esac
}

read_lf_line() {
  file_value=
  [ -f "$1" ] && [ -r "$1" ] || return 1
  file_size=$(wc -c < "$1") || return 1
  case "$file_size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$file_size" -ge "$2" ] && [ "$file_size" -le "$3" ] || return 1
  [ "$(wc -l < "$1" | tr -d ' ')" = 1 ] || return 1
  [ "$(tail -c 1 "$1" | od -An -t u1 | tr -d ' ')" = 10 ] || return 1
  ! grep -q "$(printf '\r')" "$1" || return 1
  IFS= read -r file_value < "$1" || return 1
}

if [ "$#" -ne 0 ] ||
  ! require_value APOLLO_ADMIN_SOURCE_DIRECTORY ||
  ! require_value APOLLO_ADMIN_GENERATION_PARENT ||
  ! require_value APOLLO_ADMIN_CREDENTIAL_GENERATION; then
  exit 1
fi

safe_generation "$APOLLO_ADMIN_CREDENTIAL_GENERATION" || exit 1
case "$APOLLO_ADMIN_SOURCE_DIRECTORY:$APOLLO_ADMIN_GENERATION_PARENT" in
  /*:/*) ;;
  *) exit 1 ;;
esac
[ -d "$APOLLO_ADMIN_GENERATION_PARENT" ] &&
  [ -w "$APOLLO_ADMIN_GENERATION_PARENT" ] || exit 1

user_file="${APOLLO_ADMIN_SOURCE_DIRECTORY%/}/admin_access_user"
password_file="${APOLLO_ADMIN_SOURCE_DIRECTORY%/}/admin_access_password"
[ "$(stat -c '%u:%g:%a' "$user_file" 2>/dev/null)" = "0:0:600" ] &&
  [ "$(stat -c '%u:%g:%a' "$password_file" 2>/dev/null)" = "0:0:600" ] ||
  exit 1

read_lf_line "$user_file" 2 129 || exit 1
admin_user=$file_value
printf '%s\n' "$admin_user" |
  grep -Eq '^[A-Za-z0-9_.@-]{1,128}$' || exit 1
read_lf_line "$password_file" 17 4097 || exit 1
unset file_value

stage=claim
generation_directory="${APOLLO_ADMIN_GENERATION_PARENT%/}/$APOLLO_ADMIN_CREDENTIAL_GENERATION"
mkdir "$generation_directory" 2>/dev/null || exit 1
claimed=1
chmod 0750 "$generation_directory" || exit 1

hash_file="$generation_directory/password-hash.tmp"
htpasswd_temporary="$generation_directory/admin_access_htpasswd.tmp"
caddy_temporary="$generation_directory/caddy.env.tmp"
htpasswd_final="$generation_directory/admin_access_htpasswd"
caddy_final="$generation_directory/caddy.env"

stage=hash
caddy hash-password < "$password_file" > "$hash_file" 2>/dev/null || exit 1
read_lf_line "$hash_file" 61 61 || exit 1
password_hash=$file_value
printf '%s\n' "$password_hash" |
  grep -Eq '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' || exit 1

stage=write
printf '%s:%s' "$admin_user" "$password_hash" > "$htpasswd_temporary"
printf "APOLLO_ADMIN_CADDY_USER='%s'\nAPOLLO_ADMIN_CADDY_PASSWORD_HASH='%s'\n" \
  "$admin_user" "$password_hash" > "$caddy_temporary"
chmod 0400 "$htpasswd_temporary" || exit 1
chmod 0640 "$caddy_temporary" || exit 1
chown root:root "$htpasswd_temporary" || exit 1
chown root:caddy "$caddy_temporary" || exit 1
chown root:caddy "$generation_directory" || exit 1
chmod 0750 "$generation_directory" || exit 1

stage=publish
mv "$htpasswd_temporary" "$htpasswd_final" || exit 1
mv "$caddy_temporary" "$caddy_final" || exit 1
rm -f "$hash_file" || exit 1
completed=1
unset admin_user password_hash file_value
printf 'admin-credential-generation: complete\n'
