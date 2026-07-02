/**
 * Centralized type exports for the Uptime Kuma MCP Server
 */

// Configuration
export * from './config.js';

// Settings
export * from './settings.js';

// API Responses (includes MonitorList and GetMonitorResponse)
export * from './responses.js';

// Heartbeats
export * from './heartbeat.js';

// Tags
export * from './tags.js';

// Monitor Authentication & Related Schemas
export * from './monitor-auth.js';

// Monitor Conditions
export * from './monitor-conditions.js';

// Monitor Base Schemas (MonitorBase, MonitorSummary, etc.)
export * from './monitor-base.js';

// Monitor Type Schemas (all specific monitor types, Monitor, MonitorCreate, MonitorUpdate, MonitorBaseWithExtendedData, MonitorWithExtendedData, MonitorRawData)
export * from './monitor-types.js';

// Notification schemas
export * from './notification.js';

// Maintenance window schemas
export * from './maintenance.js';

// Status page schemas
export * from './status-page.js';

// Docker host schemas
export * from './docker-host.js';
