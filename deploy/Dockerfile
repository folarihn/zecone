FROM rust:1.89-bookworm AS zcash-watch-builder
ENV CARGO_BUILD_JOBS=2
WORKDIR /src
COPY services/zcash-watch/Cargo.toml services/zcash-watch/Cargo.lock ./services/zcash-watch/
COPY services/zcash-watch/src ./services/zcash-watch/src
RUN cargo build --locked --release --manifest-path services/zcash-watch/Cargo.toml

FROM node:24.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    ZECONE_READ_ONLY=1 \
    ZECONE_STATE=/var/lib/zecone \
    ZECONE_CONFIG=/etc/zecone
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 zecone \
 && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin zecone \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/zecone /var/log/zecone \
 && install -d -o root -g 10001 -m 0750 /etc/zecone
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY --chown=root:root services ./services
COPY --chown=root:root scripts ./scripts
COPY --chown=root:root config ./config
COPY --chown=root:root deploy/config ./deploy/config
COPY --from=zcash-watch-builder /src/services/zcash-watch/target/release/zecone-zcash-watch /usr/local/bin/zecone-zcash-watch
RUN chmod 0555 /usr/local/bin/zecone-zcash-watch \
 && find /app -type d -exec chmod 0555 {} + \
 && find /app -type f -exec chmod 0444 {} +
USER 10001:10001
EXPOSE 3410
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-transform-types", "scripts/vps-readonly-service.ts"]

