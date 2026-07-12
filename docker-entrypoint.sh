#!/bin/sh
# Start the cron daemon so crontab entries added by ai-shell actually run.
service cron start 2>/dev/null || cron 2>/dev/null || true
exec node /app/cli.js
