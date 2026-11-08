# Capri Web: the page is exported once (Node), the server is one Rust binary that serves it.
# Settings, keys, chats and mcp.json live in /app/data.
FROM node:24-alpine AS page
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM rust:alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY server-rs server-rs
COPY shared shared
RUN cargo build --release --manifest-path server-rs/Cargo.toml --target-dir /target

FROM alpine:3
# tzdata: her clock and reminders follow TZ from docker-compose.yml.
RUN apk add --no-cache tzdata && adduser -D -u 1000 capri
WORKDIR /app
# HOSTNAME: Docker sets it to the container id, which the server would then try to bind.
ENV HOSTNAME=0.0.0.0 PORT=3000 CAPRI_DATA_DIR=/app/data CAPRI_MCP_CONFIG=/app/data/mcp.json CAPRI_STATIC_DIR=/app/out
COPY --from=server /target/release/capri-server /usr/local/bin/capri-server
COPY --from=page /app/out ./out
# A fresh named volume copies this folder, so it starts out owned by the user the app runs as.
RUN mkdir -p data && chown capri:capri data && chmod 700 data
USER capri
EXPOSE 3000
CMD ["capri-server"]
