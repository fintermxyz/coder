#!/bin/sh
echo "=== MCP server status ==="
curl -s http://localhost:3333/health | node -e "
  let b=''; process.stdin.on('data',d=>b+=d).on('end',()=>{
    const j=JSON.parse(b);
    console.log('Status :', j.status);
    console.log('Tools  :', j.tools);
    console.log('Sessions:', j.sessions);
  });
"
echo ""
echo "Container:"
container ls 2>/dev/null | grep mcp || echo "  (not running)"
