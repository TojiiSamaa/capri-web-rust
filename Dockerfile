# Capri Web, built and served with `next start`. Settings, keys, chats and mcp.json live in /app/data.
FROM node:24-alpine
# tzdata: her clock and reminders follow TZ from docker-compose.yml.
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production CAPRI_MCP_CONFIG=/app/data/mcp.json
# A fresh named volume copies this folder, so it starts out owned by the user the app runs as.
RUN mkdir -p data && chown node:node data && chmod 700 data
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
