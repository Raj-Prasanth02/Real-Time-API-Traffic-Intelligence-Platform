# Traffic Intelligence API

A Node.js and TypeScript backend for collecting API request telemetry and turning it into operational insight: request volume, latency, error rate, endpoint health, and alerts. Telemetry is stored in MongoDB so it can be inspected using MongoDB Compass.

## Quick start

```bash
npm install
npm run dev
```

Before starting the API, make sure a MongoDB server is running locally. MongoDB Compass is a database client; it connects to the MongoDB server but does not replace it.

Copy `.env.example` to `.env` if you want to change the defaults:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=traffic_intelligence
```

The API runs at `http://localhost:3000`.

## Endpoints

- `GET /health` - liveness and service metadata
- `POST /v1/telemetry` - ingest one completed API request
- `POST /v1/telemetry/batch` - ingest up to 500 requests
- `GET /v1/metrics/overview` - aggregate traffic over a time window
- `GET /v1/metrics/endpoints` - endpoint-level metrics
- `GET /v1/requests` - recent request events
- `GET /v1/alerts` - active threshold alerts

Example telemetry payload:

```json
{
  "service": "checkout-api",
  "environment": "production",
  "method": "POST",
  "path": "/orders",
  "statusCode": 201,
  "durationMs": 148,
  "timestamp": "2026-10-07T12:00:00.000Z",
  "traceId": "trace-123",
  "region": "ap-south-1"
}
```

## MongoDB data

The application creates this database and collection automatically:

```text
Database: traffic_intelligence
Collection: telemetry_events
Collection: overview_snapshots
Collection: metric_snapshots
Collection: alert_events
```

In MongoDB Compass, connect to `mongodb://127.0.0.1:27017`, then open `traffic_intelligence`. `telemetry_events` contains raw requests. `overview_snapshots`, `metric_snapshots`, and `alert_events` contain the calculated results returned by the metrics and alerts endpoints. Derived documents are updated for the same endpoint and time window instead of being duplicated on every read.

The test suite uses an isolated in-memory repository, so automated tests do not require MongoDB to be running.

## Next production slices

1. Add API-key/project authentication and tenant isolation.
2. Add Redis or Kafka ingestion for high-volume, non-blocking telemetry.
3. Add WebSocket or Server-Sent Events subscriptions for live dashboards.
4. Add OpenTelemetry SDK support and background anomaly detection.
