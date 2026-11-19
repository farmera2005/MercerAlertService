#!/bin/sh
# Nightly pg_dump sidecar. Custom-format dumps (restore with pg_restore), rotated after
# BACKUP_KEEP_DAYS. Run an immediate backup with:  docker compose exec backup /backup.sh now
set -eu
# Dumps hold the whole database (secrets are sealed, but audit and contact data are not): owner-only.
umask 077
: "${BACKUP_TIME:=02:30}"        # local time (TZ) to run daily
: "${BACKUP_KEEP_DAYS:=14}"
: "${BACKUP_DIR:=/backups}"
if [ -n "${PGPASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$PGPASSWORD_FILE")"; export PGPASSWORD; fi

run_backup() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/mas-$ts.dump"
  if pg_dump -Fc --no-owner -f "$out.partial"; then
    mv "$out.partial" "$out"
    echo "$(date -Iseconds) backup ok: $out ($(du -h "$out" | cut -f1))"
    date -Iseconds > "$BACKUP_DIR/.last_success"
  else
    rm -f "$out.partial"
    echo "$(date -Iseconds) BACKUP FAILED" >&2
    return 1
  fi
  find "$BACKUP_DIR" -name 'mas-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -print -delete
}

if [ "${1:-}" = "now" ]; then run_backup; exit $?; fi

echo "$(date -Iseconds) backup sidecar: daily at $BACKUP_TIME ($TZ), keeping $BACKUP_KEEP_DAYS days in $BACKUP_DIR"
until pg_isready -q; do sleep 5; done
while true; do
  if [ "$(date +%H:%M)" = "$BACKUP_TIME" ]; then
    run_backup || true
    sleep 61
  fi
  sleep 20
done
