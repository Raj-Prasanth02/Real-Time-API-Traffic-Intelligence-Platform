import { z } from 'zod';

export const telemetrySchema = z.object({
  service: z.string().min(1).max(100),
  environment: z.string().min(1).max(50).default('development'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().min(1).max(500),
  statusCode: z.number().int().min(100).max(599),
  durationMs: z.number().finite().min(0).max(300_000),
  timestamp: z.coerce.date().default(() => new Date()),
  traceId: z.string().min(1).max(200).optional(),
  region: z.string().min(1).max(100).optional()
});

export type TelemetryEvent = z.infer<typeof telemetrySchema> & { id: string };

export type EndpointMetric = {
  service: string;
  environment: string;
  method: TelemetryEvent['method'];
  path: string;
  requestCount: number;
  errorCount: number;
  errorRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
};

export type Alert = {
  type: 'high_error_rate' | 'high_latency';
  severity: 'warning' | 'critical';
  service: string;
  environment: string;
  method: TelemetryEvent['method'];
  path: string;
  value: number;
  threshold: number;
  observedAt: string;
};

export type MetricWindow = {
  from: Date;
  to: Date;
};
