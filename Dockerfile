# check=skip=SecretsUsedInArgOrEnv
# Build stage. Runs on the build machine's own architecture whatever the target: its output
# is JavaScript, so nothing here needs emulating.
FROM --platform=$BUILDPLATFORM node:26-alpine AS builder

# Accept version as build argument
ARG VERSION=dev

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Inject version into source before compiling
RUN sed -i "s/0\.0\.0-dev/${VERSION}/" src/version.ts

# Build TypeScript
RUN npm run build

# Production stage
FROM node:26-alpine

# Accept version as build argument (must be redeclared per stage)
ARG VERSION=dev

# Metadata labels
LABEL org.opencontainers.image.title="mcp-uptime-kuma"
LABEL org.opencontainers.image.description="A Model Context Protocol server for Uptime Kuma v2."
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.authors="David Fuchs <david@davidfuchs.ca>"
LABEL org.opencontainers.image.url="https://hub.docker.com/r/davidfuchs/mcp-uptime-kuma"
LABEL org.opencontainers.image.source="https://github.com/DavidFuchs/mcp-uptime-kuma"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.documentation="https://github.com/DavidFuchs/mcp-uptime-kuma#readme"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Copy entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Set environment variables (documentation and runtime override)
ENV UPTIME_KUMA_URL=""
ENV UPTIME_KUMA_USERNAME=""
ENV UPTIME_KUMA_PASSWORD=""
ENV UPTIME_KUMA_2FA_TOKEN=""
ENV UPTIME_KUMA_JWT_TOKEN=""
# Guards for the streamable HTTP transport. Both are permissive by default; the server
# warns at startup when it is left unprotected. See "Securing the HTTP Endpoint" in README.
ENV MCP_AUTH_TOKEN=""
ENV ALLOWED_ORIGIN="*"
ENV HOST="0.0.0.0"
ENV PORT=3000

# Nothing here needs root: the port is unprivileged and the app only reads its own files.
USER node

# Expose port for HTTP transport
EXPOSE 3000

# Probes /health when the container runs the HTTP transport. Under stdio, the default, there
# is no port to probe and the check passes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

# Run the application (default to stdio transport)
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["-t", "stdio"]
