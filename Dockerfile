# check=skip=SecretsUsedInArgOrEnv
# Build stage
FROM node:18-alpine AS builder

# Accept version as build argument
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
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

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
ENV ALLOWED_ORIGIN="*"
ENV PORT=3000

# Expose port for HTTP transport
EXPOSE 3000

# Run the application (default to stdio transport)
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["-t", "stdio"]
