# Steady backend (Hono API + web pages like /invitation and /admin) for Render's free tier.
# Build: workspace install -> Vite web build -> single-file Bun server bundle.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
COPY . .
RUN bun install --frozen-lockfile --filter '@template/web'
RUN cd packages/web && bunx vite build
RUN bun build packages/web/src/server.ts --target=bun --outdir /out/src

# Runtime: small image, no node_modules needed.
FROM oven/bun:1.3.14-slim
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY --from=build /out/src ./src
COPY --from=build /app/packages/web/dist ./dist
EXPOSE 10000
CMD ["bun", "src/server.js"]
