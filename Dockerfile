# Build stage
FROM node:18-alpine AS builder

# Metadata labels
LABEL org.opencontainers.image.title="mcp-uptime-kuma"
LABEL org.opencontainers.image.description="A Model Context Protocol server for Uptime Kuma v2 supporting stdio and streamable HTTP transports"
LABEL org.opencontainers.image.version="0.3.1"
LABEL org.opencontainers.image.authors="David Fuchs <david@davidfuchs.ca>"
LABEL org.opencontainers.image.url="https://github.com/DavidFuchs/mcp-uptime-kuma"
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

# Set environment variables (these should be overridden at runtime)
ENV UPTIME_KUMA_URL=""
ENV UPTIME_KUMA_USERNAME=""
ENV UPTIME_KUMA_PASSWORD=""
ENV PORT=3000

# Expose port for HTTP transport
EXPOSE 3000

# Run the application (default to stdio transport)
ENTRYPOINT ["node", "dist/index.js"]
CMD ["-t", "stdio"]
