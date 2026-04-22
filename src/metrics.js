const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const joinStageFailuresTotal = new client.Counter({
  name: "vc_join_stage_failures_total",
  help: "Join-stage failures by stage",
  labelNames: ["stage"]
});

const sessionsCreatedTotal = new client.Counter({
  name: "vc_sessions_created_total",
  help: "Total sessions created"
});

const joinTokensIssuedTotal = new client.Counter({
  name: "vc_join_tokens_issued_total",
  help: "Total join tokens issued"
});

const replayRejectedTotal = new client.Counter({
  name: "vc_token_replay_rejected_total",
  help: "Total replay-rejected token usages"
});

const activeSessionsGauge = new client.Gauge({
  name: "vc_active_sessions",
  help: "Current active sessions"
});

const mediasoupRoutersGauge = new client.Gauge({
  name: "vc_mediasoup_active_routers",
  help: "Current active mediasoup routers"
});

const mediasoupTransportsGauge = new client.Gauge({
  name: "vc_mediasoup_active_transports",
  help: "Current active mediasoup transports"
});

const mediasoupProducersGauge = new client.Gauge({
  name: "vc_mediasoup_active_producers",
  help: "Current active mediasoup producers"
});

const mediasoupConsumersGauge = new client.Gauge({
  name: "vc_mediasoup_active_consumers",
  help: "Current active mediasoup consumers"
});

const backendErrorsTotal = new client.Counter({
  name: "vc_backend_errors_total",
  help: "Backend errors by area",
  labelNames: ["area"]
});

const reconnectAttemptsTotal = new client.Counter({
  name: "vc_reconnect_attempts_total",
  help: "Total reconnect attempts"
});

const reconnectSuccessTotal = new client.Counter({
  name: "vc_reconnect_success_total",
  help: "Total successful reconnects"
});

const reconnectTimeoutTotal = new client.Counter({
  name: "vc_reconnect_timeout_total",
  help: "Reconnect grace timeout expirations"
});

const qualityReportsTotal = new client.Counter({
  name: "vc_quality_reports_total",
  help: "Quality reports received by severity",
  labelNames: ["severity"]
});

const qualityAlertsTotal = new client.Counter({
  name: "vc_quality_alerts_total",
  help: "Quality alerts emitted by severity",
  labelNames: ["severity"]
});

const qualityOutboundRttMs = new client.Histogram({
  name: "vc_quality_outbound_rtt_ms",
  help: "Reported outbound RTT in milliseconds",
  buckets: [50, 100, 200, 300, 400, 600, 800, 1200, 2000]
});

const qualityInboundJitterMs = new client.Histogram({
  name: "vc_quality_inbound_jitter_ms",
  help: "Reported inbound jitter in milliseconds",
  buckets: [1, 5, 10, 20, 40, 80, 120, 200]
});

const qualityInboundPacketLossPct = new client.Histogram({
  name: "vc_quality_inbound_packet_loss_pct",
  help: "Reported inbound packet loss percentage",
  buckets: [0.5, 1, 2, 4, 8, 12, 20, 40]
});

registry.registerMetric(joinStageFailuresTotal);
registry.registerMetric(sessionsCreatedTotal);
registry.registerMetric(joinTokensIssuedTotal);
registry.registerMetric(replayRejectedTotal);
registry.registerMetric(activeSessionsGauge);
registry.registerMetric(mediasoupRoutersGauge);
registry.registerMetric(mediasoupTransportsGauge);
registry.registerMetric(mediasoupProducersGauge);
registry.registerMetric(mediasoupConsumersGauge);
registry.registerMetric(backendErrorsTotal);
registry.registerMetric(reconnectAttemptsTotal);
registry.registerMetric(reconnectSuccessTotal);
registry.registerMetric(reconnectTimeoutTotal);
registry.registerMetric(qualityReportsTotal);
registry.registerMetric(qualityAlertsTotal);
registry.registerMetric(qualityOutboundRttMs);
registry.registerMetric(qualityInboundJitterMs);
registry.registerMetric(qualityInboundPacketLossPct);

module.exports = {
  registry,
  joinStageFailuresTotal,
  sessionsCreatedTotal,
  joinTokensIssuedTotal,
  replayRejectedTotal,
  activeSessionsGauge,
  mediasoupRoutersGauge,
  mediasoupTransportsGauge,
  mediasoupProducersGauge,
  mediasoupConsumersGauge,
  backendErrorsTotal,
  reconnectAttemptsTotal,
  reconnectSuccessTotal,
  reconnectTimeoutTotal,
  qualityReportsTotal,
  qualityAlertsTotal,
  qualityOutboundRttMs,
  qualityInboundJitterMs,
  qualityInboundPacketLossPct
};
