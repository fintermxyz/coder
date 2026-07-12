#!/bin/sh
container rm ai-shell-sandbox 2>/dev/null
container run -it \
  --name ai-shell-sandbox \
  -m 3G \
  --network mcp-net \
  -e LMSTUDIO_URL=http://172.20.10.3:1234/v1 \
  -e AI_PROVIDER=lmstudio \
  -e AI_AUTO=1 \
  -e BRAVE_API_KEY=BSAK47YGQxXE6eoCBv9xz1XZ_DJ9iS9 \
  -v "$HOME/nextjs-workspace:/workspace" \
  -p 3001:3000 \
  ai-shell
