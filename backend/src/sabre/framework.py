"""What the factory asks of the web framework, in every application it serves."""

from fastapi.telemetry import TelemetryConfig

# FastAPI writes its own telemetry to the process-wide OpenTelemetry providers: a span per request
# with its path and query string, and so one trace per health check. The factory writes its own
# spans, from a closed set with allowlisted attributes, through a provider it keeps to itself
# (sabre.telemetry). The framework's telemetry is therefore off in the API, the executor and both
# runner bridges; this module imports only the framework so that each of them can use it.
TELEMETRY_OFF: TelemetryConfig = {"tracing": False, "metrics": False, "logs": False}
