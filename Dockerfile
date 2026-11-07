# Capri Web, built once and served with Next's standalone server. Settings, keys, chats and mcp.json live in /app/data.
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 CAPRI_STANDALONE=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
# tzdata: her clock and reminders follow TZ from docker-compose.yml.
RUN apk add --no-cache tzdata
WORKDIR /app
# HOSTNAME: Docker sets it to the container id, which the server would then try to bind.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 CAPRI_MCP_CONFIG=/app/data/mcp.json
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# A fresh named volume copies this folder, so it starts out owned by the user the app runs as.
RUN mkdir -p data && chown node:node data && chmod 700 data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
