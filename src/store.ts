import { randomUUID } from 'node:crypto';
import { Collection, MongoClient } from 'mongodb';
import type { Alert, EndpointMetric, MetricWindow, TelemetryEvent } from './domain.js';

export type AlertThresholds = {
  errorRate: number;
  latencyMs: number;
};

export type TelemetryRepository = {
  connect(): Promise<void>;
  close(): Promise<void>;
  add(input: Omit<TelemetryEvent, 'id'>): Promise<TelemetryEvent>;
  addMany(inputs: Omit<TelemetryEvent, 'id'>[]): Promise<TelemetryEvent[]>;
  query(window: MetricWindow, limit?: number): Promise<TelemetryEvent[]>;
  overview(window: MetricWindow): Promise<ReturnType<typeof overviewFor>>;
  endpointMetrics(window: MetricWindow): Promise<EndpointMetric[]>;
  alerts(window: MetricWindow, thresholds: AlertThresholds): Promise<Alert[]>;
};

type StoredTelemetryEvent = Omit<TelemetryEvent, 'id'> & { _id: string };
type OverviewSnapshot = ReturnType<typeof overviewFor>;
type StoredOverviewSnapshot = OverviewSnapshot & { _id: string; windowFrom: Date; windowTo: Date; recordedAt: Date };
type StoredMetricSnapshot = EndpointMetric & { _id: string; windowFrom: Date; windowTo: Date; recordedAt: Date };
type StoredAlert = Alert & { _id: string; windowFrom: Date; windowTo: Date; recordedAt: Date };

export class MongoTelemetryStore implements TelemetryRepository {
  private readonly client: MongoClient;
  private readonly databaseName: string;
  private collection?: Collection<StoredTelemetryEvent>;
  private overviewCollection?: Collection<StoredOverviewSnapshot>;
  private metricsCollection?: Collection<StoredMetricSnapshot>;
  private alertsCollection?: Collection<StoredAlert>;

  constructor(
    uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    databaseName = process.env.MONGODB_DATABASE ?? 'traffic_intelligence'
  ) {
    this.client = new MongoClient(uri);
    this.databaseName = databaseName;
  }

  async connect() {
    await this.client.connect();
    const database = this.client.db(this.databaseName);
    this.collection = database.collection<StoredTelemetryEvent>('telemetry_events');
    this.overviewCollection = database.collection<StoredOverviewSnapshot>('overview_snapshots');
    this.metricsCollection = database.collection<StoredMetricSnapshot>('metric_snapshots');
    this.alertsCollection = database.collection<StoredAlert>('alert_events');
    await this.collection.createIndex({ timestamp: -1 });
    await this.collection.createIndex({ service: 1, environment: 1, method: 1, path: 1, timestamp: -1 });
    await this.overviewCollection.createIndex({ windowFrom: 1, windowTo: 1 }, { unique: true });
    await this.metricsCollection.createIndex({ service: 1, environment: 1, method: 1, path: 1, windowFrom: 1, windowTo: 1 }, { unique: true });
    await this.alertsCollection.createIndex({ type: 1, service: 1, environment: 1, method: 1, path: 1, windowFrom: 1, windowTo: 1 }, { unique: true });
  }

  async close() {
    await this.client.close();
  }

  async add(input: Omit<TelemetryEvent, 'id'>) {
    const event: StoredTelemetryEvent = { ...input, _id: randomUUID() };
    await this.getCollection().insertOne(event);
    return toTelemetryEvent(event);
  }

  async addMany(inputs: Omit<TelemetryEvent, 'id'>[]) {
    const events = inputs.map((input) => ({ ...input, _id: randomUUID() }));
    await this.getCollection().insertMany(events);
    return events.map(toTelemetryEvent);
  }

  async query(window: MetricWindow, limit = 100) {
    const events = await this.eventsIn(window, limit);
    return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  async overview(window: MetricWindow) {
    const overview = overviewFor(await this.eventsIn(window), window);
    await this.getOverviewCollection().replaceOne(
      { windowFrom: window.from, windowTo: window.to },
      { ...overview, windowFrom: window.from, windowTo: window.to, recordedAt: new Date() },
      { upsert: true }
    );
    return overview;
  }

  async endpointMetrics(window: MetricWindow) {
    const metrics = endpointMetricsFor(await this.eventsIn(window));
    const collection = this.getMetricsCollection();
    if (metrics.length > 0) {
      await collection.bulkWrite(metrics.map((metric) => ({
        replaceOne: {
          filter: { service: metric.service, environment: metric.environment, method: metric.method, path: metric.path, windowFrom: window.from, windowTo: window.to },
          replacement: { ...metric, _id: metricKey(metric, window), windowFrom: window.from, windowTo: window.to, recordedAt: new Date() },
          upsert: true
        }
      })));
    }
    return metrics;
  }

  async alerts(window: MetricWindow, thresholds: AlertThresholds) {
    const alerts = alertsFor(await this.endpointMetrics(window), window, thresholds);
    const collection = this.getAlertsCollection();
    if (alerts.length > 0) {
      await collection.bulkWrite(alerts.map((alert) => ({
        replaceOne: {
          filter: { type: alert.type, service: alert.service, environment: alert.environment, method: alert.method, path: alert.path, windowFrom: window.from, windowTo: window.to },
          replacement: { ...alert, _id: alertKey(alert, window), windowFrom: window.from, windowTo: window.to, recordedAt: new Date() },
          upsert: true
        }
      })));
    }
    return alerts;
  }

  private async eventsIn(window: MetricWindow, limit?: number) {
    const cursor = this.getCollection()
      .find({ timestamp: { $gte: window.from, $lte: window.to } })
      .sort({ timestamp: -1 });
    if (limit) cursor.limit(limit);
    const events = await cursor.toArray();
    return events.map(toTelemetryEvent);
  }

  private getCollection() {
    if (!this.collection) throw new Error('MongoDB store is not connected');
    return this.collection;
  }

  private getOverviewCollection() {
    if (!this.overviewCollection) throw new Error('MongoDB store is not connected');
    return this.overviewCollection;
  }

  private getMetricsCollection() {
    if (!this.metricsCollection) throw new Error('MongoDB store is not connected');
    return this.metricsCollection;
  }

  private getAlertsCollection() {
    if (!this.alertsCollection) throw new Error('MongoDB store is not connected');
    return this.alertsCollection;
  }
}

export class MemoryTelemetryStore implements TelemetryRepository {
  private readonly events: TelemetryEvent[] = [];

  async connect() {}
  async close() {}

  async add(input: Omit<TelemetryEvent, 'id'>) {
    const event = { ...input, id: randomUUID() };
    this.events.push(event);
    return event;
  }

  async addMany(inputs: Omit<TelemetryEvent, 'id'>[]) {
    return Promise.all(inputs.map((input) => this.add(input)));
  }

  async query(window: MetricWindow, limit = 100) {
    return this.eventsIn(window).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);
  }

  async overview(window: MetricWindow) {
    return overviewFor(this.eventsIn(window), window);
  }

  async endpointMetrics(window: MetricWindow) {
    return endpointMetricsFor(this.eventsIn(window));
  }

  async alerts(window: MetricWindow, thresholds: AlertThresholds) {
    return alertsFor(await this.endpointMetrics(window), window, thresholds);
  }

  private eventsIn(window: MetricWindow) {
    return this.events.filter((event) => event.timestamp >= window.from && event.timestamp <= window.to);
  }
}

function toTelemetryEvent(event: StoredTelemetryEvent): TelemetryEvent {
  const { _id, ...rest } = event;
  return { ...rest, id: _id };
}

function metricKey(metric: EndpointMetric, window: MetricWindow) {
  return `${metric.service}:${metric.environment}:${metric.method}:${metric.path}:${window.from.toISOString()}:${window.to.toISOString()}`;
}

function alertKey(alert: Alert, window: MetricWindow) {
  return `${alert.type}:${alert.service}:${alert.environment}:${alert.method}:${alert.path}:${window.from.toISOString()}:${window.to.toISOString()}`;
}

function overviewFor(events: TelemetryEvent[], window: MetricWindow) {
  const durations = events.map((event) => event.durationMs);
  const errors = events.filter((event) => event.statusCode >= 500).length;

  return {
    requestCount: events.length,
    errorCount: errors,
    errorRate: events.length === 0 ? 0 : round(errors / events.length),
    averageLatencyMs: durations.length === 0 ? 0 : round(average(durations)),
    p95LatencyMs: percentile(durations, 0.95),
    services: new Set(events.map((event) => event.service)).size,
    window: { from: window.from.toISOString(), to: window.to.toISOString() }
  };
}

function endpointMetricsFor(events: TelemetryEvent[]): EndpointMetric[] {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    const key = `${event.service}:${event.environment}:${event.method}:${event.path}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0];
      const errorCount = group.filter((event) => event.statusCode >= 500).length;
      const durations = group.map((event) => event.durationMs);
      return {
        service: first.service,
        environment: first.environment,
        method: first.method,
        path: first.path,
        requestCount: group.length,
        errorCount,
        errorRate: round(errorCount / group.length),
        averageLatencyMs: round(average(durations)),
        p95LatencyMs: percentile(durations, 0.95)
      };
    })
    .sort((a, b) => b.requestCount - a.requestCount);
}

function alertsFor(metrics: EndpointMetric[], window: MetricWindow, thresholds: AlertThresholds): Alert[] {
  return metrics.flatMap((metric) => {
    const alerts: Alert[] = [];
    if (metric.errorRate >= thresholds.errorRate) {
      alerts.push({
        type: 'high_error_rate',
        severity: metric.errorRate >= thresholds.errorRate * 2 ? 'critical' : 'warning',
        service: metric.service,
        environment: metric.environment,
        method: metric.method,
        path: metric.path,
        value: metric.errorRate,
        threshold: thresholds.errorRate,
        observedAt: window.to.toISOString()
      });
    }
    if (metric.p95LatencyMs >= thresholds.latencyMs) {
      alerts.push({
        type: 'high_latency',
        severity: metric.p95LatencyMs >= thresholds.latencyMs * 2 ? 'critical' : 'warning',
        service: metric.service,
        environment: metric.environment,
        method: metric.method,
        path: metric.path,
        value: metric.p95LatencyMs,
        threshold: thresholds.latencyMs,
        observedAt: window.to.toISOString()
      });
    }
    return alerts;
  });
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
