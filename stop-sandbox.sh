#!/bin/sh
container stop ai-shell-sandbox 2>/dev/null
container rm ai-shell-sandbox 2>/dev/null
echo "sandbox stopped."
