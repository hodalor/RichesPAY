const httpRequests = new Map<string, number>();
const httpDuration = new Map<string, { count: number; sum: number }>();
const channelOutcomes = new Map<string, number>();
const gauges = new Map<string, number>();

export function recordHttpRequest(input: {
  durationSeconds: number;
  method: string;
  route: string;
  status: number;
}) {
  const key = labelKey({
    method: input.method,
    route: input.route,
    status: String(input.status)
  });
  httpRequests.set(key, (httpRequests.get(key) ?? 0) + 1);
  const duration = httpDuration.get(key) ?? { count: 0, sum: 0 };
  duration.count += 1;
  duration.sum += input.durationSeconds;
  httpDuration.set(key, duration);
}

export function recordChannelOutcome(input: {
  channel: string;
  country: string;
  network: string;
  outcome: "failed" | "success";
}) {
  const key = labelKey({
    channel: input.channel,
    country: input.country,
    network: input.network,
    outcome: input.outcome
  });
  channelOutcomes.set(key, (channelOutcomes.get(key) ?? 0) + 1);
}

export function setGauge(name: string, value: number, labels: Record<string, string> = {}) {
  gauges.set(`${name}|${labelKey(labels)}`, value);
}

export function renderPrometheusMetrics(): string {
  const lines = [
    "# HELP richespay_http_requests_total HTTP requests handled by the API.",
    "# TYPE richespay_http_requests_total counter"
  ];

  for (const [key, value] of httpRequests) {
    lines.push(`richespay_http_requests_total{${key}} ${value}`);
  }

  lines.push(
    "# HELP richespay_http_request_duration_seconds Request latency.",
    "# TYPE richespay_http_request_duration_seconds summary"
  );
  for (const [key, value] of httpDuration) {
    lines.push(`richespay_http_request_duration_seconds_sum{${key}} ${value.sum}`);
    lines.push(`richespay_http_request_duration_seconds_count{${key}} ${value.count}`);
  }

  lines.push(
    "# HELP richespay_channel_outcomes_total Provider attempts by country, channel and network.",
    "# TYPE richespay_channel_outcomes_total counter"
  );
  for (const [key, value] of channelOutcomes) {
    lines.push(`richespay_channel_outcomes_total{${key}} ${value}`);
  }

  lines.push("# HELP richespay_gauge Operational gauges used by alert rules.", "# TYPE richespay_gauge gauge");
  for (const [key, value] of gauges) {
    const splitAt = key.indexOf("|");
    const name = key.slice(0, splitAt);
    const labels = key.slice(splitAt + 1);
    lines.push(`richespay_${name}${labels ? `{${labels}}` : ""} ${value}`);
  }

  return `${lines.join("\n")}\n`;
}

function labelKey(labels: Record<string, string>) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}
