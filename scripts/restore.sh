#!/bin/sh
set -eu
archive="${1:?Usage: sh scripts/restore.sh /absolute/tasknotes-data.tgz}"
case "$archive" in /*) ;; *) echo 'Use an absolute archive path' >&2; exit 1;; esac
test -f "$archive"
docker compose stop server
docker compose run --rm --no-deps --user root -v "$archive:/backup/data.tgz:ro" --entrypoint sh server -c 'test -z "$(find /data -mindepth 1 ! -type d -print -quit)" || { echo "Restore requires a volume with no existing files" >&2; exit 1; }; tar -xzf /backup/data.tgz -C /data; chown -R node:node /data'
docker compose up -d server
