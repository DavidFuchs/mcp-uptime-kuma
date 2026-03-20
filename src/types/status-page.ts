import { z } from 'zod';

/**
 * Status page schema
 */
export const StatusPageSchema = z.object({
  id: z.number().optional().describe('Status page ID'),
  slug: z.string().describe('URL slug for the status page'),
  title: z.string().describe('Title of the status page'),
  description: z.string().optional().describe('Description shown on the status page'),
  theme: z.string().optional().describe('Theme (light or dark)'),
  published: z.boolean().optional().describe('Whether the status page is publicly accessible'),
  showTags: z.boolean().optional().describe('Whether to show tags on the status page'),
  domainNameList: z.array(z.string()).optional().describe('Custom domain names for this status page'),
  customCSS: z.string().optional().describe('Custom CSS for the status page'),
  footerText: z.string().optional().nullable().describe('Footer text'),
  showPoweredBy: z.boolean().optional().describe('Whether to show Uptime Kuma branding'),
  icon: z.string().optional().describe('Icon URL or path'),
}).passthrough();

export type StatusPage = z.infer<typeof StatusPageSchema>;
