FROM node:20-slim

# System packages: Chromium for browser agent + cron daemon
RUN apt-get update && apt-get install -y \
  chromium \
  cron \
  fonts-liberation \
  libnss3 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Use system Chromium — skip playwright's bundled download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# /workspace is bind-mounted from the host at runtime
WORKDIR /workspace
ENTRYPOINT ["/app/docker-entrypoint.sh"]
