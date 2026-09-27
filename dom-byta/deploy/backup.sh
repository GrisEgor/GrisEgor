#!/bin/sh
# Резервная копия: база + загруженные фото. Хранит последние 14 копий.
# Запуск из папки dom-byta: sh deploy/backup.sh
# Для ежедневного запуска (crontab -e):
#   30 3 * * * cd /opt/grisegor/dom-byta && sh deploy/backup.sh >> /var/log/dombyta-backup.log 2>&1
set -eu
DIR="${BACKUP_DIR:-/var/backups/dombyta}"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$DIR"
COMPOSE="docker compose -f docker-compose.prod.yml"

$COMPOSE exec -T db pg_dump -U dombyta --clean --if-exists dombyta | gzip > "$DIR/db_$STAMP.sql.gz"
$COMPOSE exec -T app tar -C /app -czf - uploads > "$DIR/uploads_$STAMP.tar.gz"

ls -1t "$DIR"/db_*.sql.gz | tail -n +15 | xargs -r rm --
ls -1t "$DIR"/uploads_*.tar.gz | tail -n +15 | xargs -r rm --
echo "$STAMP: копия готова в $DIR"
