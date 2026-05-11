#!/bin/sh
set -e

# Subcommand dispatcher. Lets the same image act as orchestrator, health-cron,
# migration runner, or backtester depending on the compose `command:` line.
case "$1" in
  ingest)
    exec npx tsx src/ingest/orchestrator.ts
    ;;
  migrate)
    exec npx tsx src/db/migrate.ts
    ;;
  smoke)
    exec npx tsx scripts/smoke_5min.ts
    ;;
  health)
    exec npx tsx scripts/health.ts
    ;;
  health-cron)
    # Simple daemonized cron: run health at HEALTH_INTERVAL_SEC seconds (default 24h).
    # Output goes to stdout where `docker logs` collects it.
    INTERVAL="${HEALTH_INTERVAL_SEC:-86400}"
    echo "health-cron: interval=${INTERVAL}s"
    while true; do
      echo "===== health $(date -u +%FT%TZ) ====="
      npx tsx scripts/health.ts || echo "health exited non-zero"
      sleep "$INTERVAL"
    done
    ;;
  bt)
    shift
    exec npx tsx src/backtest/cli.ts "$@"
    ;;
  shell)
    exec /bin/sh
    ;;
  *)
    # Fall through to arbitrary command for ad-hoc debugging.
    exec "$@"
    ;;
esac
