# Justfile — локальные операции с ПРОД-стеком aif-handoff по SSH.
# Параметры подключения здесь (единственное место для правок).
# Использование:  just logs api  |  just ps  |  just shell  |  just push-db

# ─── Подключение к серверу ───────────────────────────────────
ssh_user := "observability"
ssh_host := "157.90.123.67"
ssh_port := "29504"
ssh_key  := "~/.ssh/id_ed25519_servers"

# Аутентификация: только этот ключ, без перебора агента.
ssh_opts := "-o IdentitiesOnly=yes -i " + ssh_key

# Собранные команды.
conn    := "ssh -t " + ssh_opts + " -p " + ssh_port + " " + ssh_user + "@" + ssh_host
compose := "docker compose -f docker-compose.yml -f compose.production.yml"
remote  := "cd ~/aif/aif-handoff"

# По умолчанию — список доступных команд.
default:
    @just --list

# Реалтайм-логи сервиса: api|agent|web|mcp
logs service tail="100":
    {{conn}} '{{remote}} && {{compose}} logs -f --tail={{tail}} {{service}}'

# Логи всех сервисов сразу.
logs-all tail="100":
    {{conn}} '{{remote}} && {{compose}} logs -f --tail={{tail}}'

# Статус контейнеров стека.
ps:
    {{conn}} '{{remote}} && {{compose}} ps'

# Интерактивный SSH на сервер.
shell:
    {{conn}}

# Перезапуск сервиса (после изменения конфига без передеплоя).
restart service:
    {{conn}} '{{remote}} && {{compose}} restart {{service}}'

# Запустить деплой (= триггер workflow_dispatch в GitHub Actions).
deploy:
    gh workflow run deploy.yml --repo burlet-dev/aif-handoff
    @echo "→ workflow запущен. Прогресс:  gh run watch --repo burlet-dev/aif-handoff"

# ─── БЭКАП ───────────────────────────────────────────────────
# SSH без pseudo-tty — для неинтерактивных команд с пайпом (scp).
conn_notty := "ssh " + ssh_opts + " -p " + ssh_port + " " + ssh_user + "@" + ssh_host
scp        := "scp " + ssh_opts + " -P " + ssh_port

# Снимает SQLite с сервера на локалку (тихий копи /home/helm-prod/aif/data/aif.sqlite).
# Локальный путь по умолчанию — ./backups/aif-YYYYMMDD-HHMM.sqlite.
pull-db dst="":
    @mkdir -p backups
    @STAMP=$(date +%Y%m%d-%H%M); \
     OUT="{{ if dst == "" { "backups/aif-$STAMP.sqlite" } else { dst } }}"; \
     echo "→ Копирую SQLite с сервера → $OUT"; \
     {{scp}} {{ssh_user}}@{{ssh_host}}:~/aif/data/aif.sqlite "$OUT"; \
     echo "✓ Готово: $OUT"

# Заливает локальный SQLite на сервер с заменой (полная замена БД).
# ВНИМАНИЕ: останавливает api/agent/mcp на время копирования.
push-db src="backups/aif.sqlite":
    @test -f "{{src}}" || { echo "Нет файла {{src}}" >&2; exit 1; }
    @echo "→ Заливаю {{src}} на сервер…"
    {{scp}} "{{src}}" {{ssh_user}}@{{ssh_host}}:/tmp/aif-import.sqlite
    {{conn_notty}} '{{remote}} && \
        {{compose}} stop api agent mcp && \
        mv /tmp/aif-import.sqlite ~/aif/data/aif.sqlite && \
        {{compose}} start api agent mcp'
    @echo "✓ Импорт завершён, сервисы подняты"
