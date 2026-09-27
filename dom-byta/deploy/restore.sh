#!/bin/sh
# Восстановление из копии: sh deploy/restore.sh /var/backups/dombyta/db_2026-10-01_0330.sql.gz [uploads_….tar.gz]
set -eu
COMPOSE="docker compose -f docker-compose.prod.yml"
gunzip -c "$1" | $COMPOSE exec -T db psql -U dombyta -q dombyta
if [ "${2:-}" ]; then
  $COMPOSE exec -T -u root app sh -c 'rm -rf /app/uploads/* && tar -C /app -xzf -' < "$2"
  $COMPOSE exec -T -u root app chown -R node:node /app/uploads
fi
echo "Восстановлено из $1"
