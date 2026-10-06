#!/bin/sh
set -eu
# Run from the service directory. The stopped service guarantees consistent DB and photos.
out="${1:?Usage: sh scripts/backup.sh /absolute/backup-directory}"
mkdir -p "$out"
case "$out" in /*) ;; *) echo 'Use an absolute output directory' >&2; exit 1;; esac
docker compose stop server
trap 'docker compose start server' EXIT INT TERM
docker compose run --rm --no-deps --user root -v "$out:/backup" --entrypoint sh server -c 'tar -czf /backup/tasknotes-data.tgz -C /data .'
echo 'Data archive complete. Back up secrets/ and .env separately in secure storage.'
