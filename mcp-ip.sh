#!/bin/sh
# Print the current MCP server IP and ready-to-paste connect command.
IP=$(container inspect mcp-test-server 2>/dev/null \
  | grep -o '"ipv4Address":"[^"]*"' | head -1 \
  | sed 's/"ipv4Address":"//;s/\\\/.*//;s/"//')

if [ -z "$IP" ]; then
  echo "mcp-test-server is not running. Start it with:"
  echo "  container run -d --name mcp-test-server --network mcp-net -v \$HOME/nextjs-workspace:/data mcp-test"
  exit 1
fi

echo "MCP server IP : $IP"
echo "Connect command (paste into ai-shell):"
echo "  /mcp connect test http://$IP:3333/sse"
