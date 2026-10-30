FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY sdk ./sdk
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run sdk:build

FROM node:24.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN groupadd --gid 10001 zecone \
 && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin zecone \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/zecone/payments /var/lib/zecone/access-pass
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/sdk/dist ./sdk/dist
COPY sdk/package.json ./sdk/package.json
COPY services/payments ./services/payments
COPY services/settlement/mainnet-watch.ts ./services/settlement/mainnet-watch.ts
COPY services/settlement/mainnet-pilot-pricing.ts ./services/settlement/mainnet-pilot-pricing.ts
COPY services/settlement/production-safety.ts ./services/settlement/production-safety.ts
COPY services/operations/mainnet-watch-worker.ts ./services/operations/mainnet-watch-worker.ts
COPY services/operations/candidate-segment-export.ts ./services/operations/candidate-segment-export.ts
COPY examples/access-pass ./examples/access-pass
RUN find /app -type d -exec chmod 0555 {} + && find /app -type f -exec chmod 0444 {} +
USER 10001:10001
ENTRYPOINT ["node", "--experimental-transform-types"]
