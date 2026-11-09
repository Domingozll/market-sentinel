#!/bin/sh
set -eu
umask 077
DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
chmod 700 "$DATA_DIR"
exec gosu node node dist/server.js
