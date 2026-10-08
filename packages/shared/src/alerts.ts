import { z } from 'zod';

export const alertTypeSchema = z.enum(['error_rate', 'slow_calls']);
export type AlertType = z.infer<typeof alertTypeSchema>;

export const activeAlertSchema = z.object({
  server: z.string().min(1).max(128),
  type: alertTypeSchema,
  value: z.number().min(0).max(3_600_000),
  threshold: z.number().min(1).max(3_600_000),
});
export type ActiveAlert = z.infer<typeof activeAlertSchema>;

export const alertEventSchema = z.object({
  id: z.number().int().safe(),
  server: z.string().min(1).max(128),
  type: alertTypeSchema,
  value: z.number().min(0).max(3_600_000),
  threshold: z.number().min(1).max(3_600_000),
  first_seen_at: z.number().int().safe(),
  last_seen_at: z.number().int().safe(),
  resolved_at: z.number().int().safe().nullable(),
  acknowledged_at: z.number().int().safe().nullable(),
  acknowledged_by: z.string().max(128).nullable(),
  notified_at: z.number().int().safe().nullable(),
  notification_error: z.string().max(256).nullable(),
});
export type AlertEvent = z.infer<typeof alertEventSchema>;

export function alertFingerprint(server: string, type: AlertType): string {
  return `${server}\u001f${type}`;
}
