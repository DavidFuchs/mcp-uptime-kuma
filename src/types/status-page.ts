import { z } from 'zod';

/**
 * Status page schema
 */
export const StatusPageSchema = z
  .object({
    id: z.number().optional().describe('Status page ID'),
    slug: z.string().describe('URL slug for the status page'),
    title: z.string().describe('Title of the status page'),
    description: z.string().optional().nullable().describe('Description shown on the status page'),
    theme: z.string().optional().nullable().describe('Theme (light or dark)'),
    published: z.boolean().optional().describe('Whether the status page is publicly accessible'),
    showTags: z.boolean().optional().describe('Whether to show tags on the status page'),
    domainNameList: z.array(z.string()).optional().describe('Custom domain names for this status page'),
    customCSS: z.string().optional().nullable().describe('Custom CSS for the status page'),
    footerText: z.string().optional().nullable().describe('Footer text'),
    showPoweredBy: z.boolean().optional().describe('Whether to show Uptime Kuma branding'),
    icon: z.string().optional().nullable().describe('Icon URL or path'),
  })
  .passthrough();

export type StatusPage = z.infer<typeof StatusPageSchema>;

/** The styles Uptime Kuma offers for an incident banner; editIncident turns any other into "warning". */
export const INCIDENT_STYLES = ['info', 'warning', 'danger', 'primary', 'light', 'dark'] as const;

/**
 * A status page incident, as Uptime Kuma's Incident.toPublicJSON() returns it. A pinned, active
 * incident is shown on the page; resolving one clears both.
 */
export const IncidentSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    content: z.string().describe('Markdown, as the status page renders it'),
    style: z.string().describe(`Banner style: ${INCIDENT_STYLES.join(', ')}`),
    pin: z.boolean().describe('Shown on the status page while also active'),
    active: z.boolean().describe('false once resolved'),
    createdDate: z.string().nullable().optional().describe('UTC, as Uptime Kuma stores it'),
    lastUpdatedDate: z.string().nullable().optional().describe('UTC, as Uptime Kuma stores it'),
    status_page_id: z.number().optional(),
  })
  .passthrough();

export type Incident = z.infer<typeof IncidentSchema>;
