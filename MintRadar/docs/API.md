# MintRadar Public API

MintRadar provides a public read-only API for querying Cashu mint data. All endpoints are served under the same origin as the web app (`https://mintradar.org/api/`).

> **Note:** This API is unofficial and may change without notice. It is intended for personal use and light integrations — not for high-frequency scraping or production dependencies.

---

## Rate Limits

| Endpoint type | Limit |
|---|---|
| All read endpoints | **60 requests / minute / IP** |
| `/api/mint/submit` (POST) | **20 requests / hour / IP** |
| `/api/mints/discover` (POST) | **10 requests / hour / IP** |

Rate limit headers are returned on all non-exempt endpoints:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
```

Exceeding the limit returns HTTP `429 Too Many Requests`:

```json
{ "error": "Too many requests" }
```

---

## Endpoints

### `GET /health`

Health check. No rate limiting.

**Response:**
```json
{ "status": "ok", "timestamp": "2026-06-25T10:00:00.000Z" }
```

---

### `GET /api/mints/known`

All known mints with current online status, latency, trust score, and metadata.

**Response:** Array of mint objects.

```json
[
  {
    "url": "https://mint.example.com",
    "name": "Example Mint",
    "iconUrl": null,
    "degraded": false,
    "online": true,
    "latencyMs": 142,
    "version": "0.16.3",
    "nutCount": 11,
    "tosUrl": null,
    "descriptionLong": null,
    "nutsLimits": { "4": {}, "5": {}, "7": {} },
    "auditNMints": 1200,
    "auditNMelts": 950,
    "auditNErrors": 3,
    "auditCheckedAt": "2026-06-24T08:00:00.000Z",
    "trustScore": 88,
    "uptimePct24h": 100,
    "discoveredAt": "2025-11-01T12:00:00.000Z",
    "serverLocation": "Frankfurt am Main, DE",
    "lastCheckedAt": "2026-06-25T09:55:00.000Z"
  }
]
```

`degraded` = mint has been offline for 24h+. `nutsLimits` keys are NUT numbers as strings.

---

### `GET /api/stats`

Network-wide statistics.

**Response:**
```json
{
  "totalMints": 97,
  "onlineMints": 72,
  "offlineMints": 25,
  "avgTrustScore": 71,
  "avgLatency24h": 210,
  "trustDistribution": { "low": 12, "moderate": 28, "high": 32 },
  "nutAdoption": [
    { "nut": "NUT-04", "count": 68, "percent": 94 }
  ],
  "top5ByTrustScore": [
    { "url": "https://mint.example.com", "name": "Example Mint", "trustScore": 93 }
  ]
}
```

---

### `GET /api/mints/history`

Bucketed uptime/latency/trust history for a single mint.

**Query parameters:**

| Parameter | Required | Values | Default |
|---|---|---|---|
| `url` | ✅ | `https://…` | — |
| `period` | ❌ | `24h`, `7d`, `30d`, `90d` | `24h` |

**Response:**
```json
{
  "url": "https://mint.example.com",
  "period": "7d",
  "segments": [
    {
      "bucket": "2026-06-18T00:00:00.000Z",
      "online": true,
      "latencyMs": 138,
      "total": 288,
      "onlineCount": 288,
      "uptimePct": 100,
      "trustScore": 91
    }
  ],
  "uptimePct": 99,
  "avgLatencyMs": 145,
  "prevUptimePct": 98,
  "prevAvgLatencyMs": 152
}
```

`trustScore` in segments is `null` for records before trust score history was introduced (historical backfill not available).

---

### `GET /api/mints/version-history`

Software version timeline for a single mint.

**Query parameters:** `url` (required, `https://…`)

**Response:**
```json
{
  "url": "https://mint.example.com",
  "history": [
    { "version": "0.16.3", "firstSeenAt": "2026-05-10T08:00:00.000Z" }
  ],
  "latestGlobalVersion": "0.16.3"
}
```

---

### `GET /api/mints/daily-uptime`

Daily uptime counts for the last 30 days for a single mint.

**Query parameters:** `url` (required, `https://…`)

**Response:**
```json
[
  { "date": "2026-06-25", "onlineCount": 288, "totalCount": 288 }
]
```

---

### `GET /api/mint/probe`

On-demand live probe of a single mint URL. Triggers an outbound fetch.

**Query parameters:** `url` (required, `https://…`)

**Response:**
```json
{
  "url": "https://mint.example.com",
  "online": true,
  "latencyMs": 143,
  "info": { "name": "Example Mint", "version": "0.16.3", "nuts": {} },
  "keysets": [{ "id": "abc123", "unit": "sat", "active": true }],
  "checkedAt": "2026-06-25T10:00:00.000Z"
}
```

---

### `GET /api/mints/nostr-reviews`

NIP-87 kind:38000 reviews for a single mint fetched live from Nostr relays.

**Query parameters:** `url` (required, `https://…`)

**Response:**
```json
[
  {
    "id": "abc123…",
    "pubkey": "deadbeef…",
    "content": "Great mint",
    "rating": 4,
    "createdAt": 1750000000,
    "source": "nostr"
  }
]
```

---

### `POST /api/mint/submit`

Submit a new mint URL for monitoring. Triggers a live probe before insertion.

**Body:** `{ "url": "https://…" }`

**Response (success):** `{ "success": true, "name": "Mint Name" }`

**Response (error):** `{ "error": "description" }`

Rate limit: **20 requests / hour / IP**.

---

### `POST /api/mints/discover`

Batch insert discovered mint URLs (max 100 per request).

**Body:** `{ "urls": ["https://…", "https://…"] }`

**Response:** `{ "added": 3 }`

Rate limit: **10 requests / hour / IP**.

---

## Error Responses

| Status | Meaning |
|---|---|
| `400` | Bad request — missing or invalid parameter |
| `429` | Rate limit exceeded |
| `500` | Internal server error |
