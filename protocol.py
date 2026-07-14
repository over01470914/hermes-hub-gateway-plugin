"""Pure protocol helpers for the Hermes Hub Gateway platform plugin."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import unquote, urlsplit

PROTOCOL = "hermes-hub-gateway-rpc/v1"

# This is ordering, not an advertised static capability set. The adapter builds
# its hello capabilities from the live loopback API Server probe on every
# connection. Keeping the order stable makes diagnostics and contract tests
# deterministic without claiming features that are not actually available.
CAPABILITY_ORDER = (
    "health",
    "sessions",
    "sessions.usage",
    "chat.stream",
    "chat.message.delta",
    "chat.reasoning",
    "chat.tools",
    "run.stop",
    "run.approval",
    "models",
    "cron",
)

# Router request/response bodies are base64 encoded inside a JSON WebSocket
# frame.  Keep the decoded contract at 25 MiB, but size the WebSocket for the
# base64 expansion plus bounded JSON/control overhead.  This avoids accepting
# an HTTP body that the Gateway's own WSS client would reject before dispatch.
MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024
MAX_RESPONSE_BODY_BYTES = 25 * 1024 * 1024
MAX_BODY_BASE64_BYTES = ((MAX_REQUEST_BODY_BYTES + 2) // 3) * 4
MAX_WIRE_FRAME_BYTES = MAX_BODY_BASE64_BYTES + (256 * 1024)
MAX_EVENT_BYTES = 2 * 1024 * 1024
MAX_STREAM_OUTPUT_BYTES = 1024 * 1024

TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled"})


class ProtocolError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "invalid_request"):
        super().__init__(message)
        self.status = status
        self.code = code


def as_record(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def decode_body_base64(value: Any) -> bytes:
    if value in (None, ""):
        return b""
    if not isinstance(value, str):
        raise ProtocolError("bodyBase64 must be a string")
    if len(value) > MAX_BODY_BASE64_BYTES:
        raise ProtocolError("request body is too large", 413, "body_too_large")
    try:
        body = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ProtocolError("bodyBase64 is not valid base64") from exc
    if len(body) > MAX_REQUEST_BODY_BYTES:
        raise ProtocolError("request body is too large", 413, "body_too_large")
    return body


def encode_body_base64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def parse_json_body(body: bytes) -> Dict[str, Any]:
    if not body:
        return {}
    try:
        value = json.loads(body.decode("utf-8"))
    except Exception as exc:
        raise ProtocolError("request body must be valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("request body must be a JSON object")
    return value


def normalized_path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError("path is required")
    raw = value.strip()
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc or parsed.fragment or "\\" in raw:
        raise ProtocolError("absolute or backslash paths are not allowed")
    path = unquote(parsed.path)
    if any(part == ".." for part in path.split("/")) or "\x00" in path:
        raise ProtocolError("unsafe path")
    normalized = "/" + path.lstrip("/")
    query = f"?{parsed.query}" if parsed.query else ""
    return normalized + query


def is_allowed_api_path(path: str, method: str) -> bool:
    pathname = path.split("?", 1)[0]
    method = method.upper()
    if pathname in {"/health", "/v1/health", "/v1/capabilities", "/v1/models"}:
        return method == "GET"
    if pathname == "/api/sessions":
        return method in {"GET", "POST"}
    if re.fullmatch(r"/api/sessions/[^/]+", pathname):
        return method in {"GET", "PATCH", "DELETE"}
    if re.fullmatch(r"/api/sessions/[^/]+/messages", pathname):
        return method == "GET"
    if re.fullmatch(r"/api/sessions/[^/]+/fork", pathname):
        return method == "POST"
    if pathname == "/api/jobs":
        return method in {"GET", "POST"}
    if re.fullmatch(r"/api/jobs/[^/]+", pathname):
        return method in {"GET", "PATCH", "DELETE"}
    if re.fullmatch(r"/api/jobs/[^/]+/(pause|resume|run)", pathname):
        return method == "POST"
    return False


def required_capability_for_api_path(path: str) -> Optional[str]:
    """Return the negotiated capability required for an allowlisted path."""

    pathname = path.split("?", 1)[0]
    if pathname in {"/health", "/v1/health", "/v1/capabilities"}:
        return "health"
    if pathname == "/v1/models":
        return "models"
    if pathname == "/api/sessions" or pathname.startswith("/api/sessions/"):
        return "sessions"
    if pathname == "/api/jobs" or pathname.startswith("/api/jobs/"):
        return "cron"
    return None


def gateway_hello(hermes_agent_id: str, gateway_id: str, capabilities: Iterable[str]) -> Dict[str, Any]:
    """Build the authenticated host hello without any credential material."""

    if not re.fullmatch(r"agent_[A-Za-z0-9._:-]{2,154}", hermes_agent_id or ""):
        raise ProtocolError("invalid Hermes Agent id", 400, "identity_invalid")
    if not re.fullmatch(r"gw_[A-Za-z0-9._:-]{5,157}", gateway_id or ""):
        raise ProtocolError("invalid Gateway id", 400, "identity_invalid")
    available = set(capabilities)
    negotiated = [item for item in CAPABILITY_ORDER if item in available]
    return {
        "type": "hello",
        "hermesAgentId": hermes_agent_id,
        "gatewayId": gateway_id,
        "runtime": "hermes-hub-gateway",
        "mode": "api-server",
        "protocols": [PROTOCOL],
        "capabilities": negotiated,
    }


def validate_router_handshake(
    value: Any,
    *,
    expected_type: str,
    hermes_agent_id: str,
    gateway_id: str,
) -> Dict[str, Any]:
    """Validate one authenticated Router control-plane handshake frame."""

    payload = as_record(value)
    if payload.get("type") != expected_type:
        raise ProtocolError(
            f"Router handshake expected {expected_type}",
            502,
            "router_handshake_unexpected",
        )
    if payload.get("hermesAgentId") != hermes_agent_id or payload.get("gatewayId") != gateway_id:
        raise ProtocolError(
            "Router handshake identity mismatch",
            502,
            "router_handshake_identity_mismatch",
        )
    protocols = payload.get("protocols")
    if (
        payload.get("protocol") != PROTOCOL
        or not isinstance(protocols, list)
        or PROTOCOL not in protocols
    ):
        raise ProtocolError(
            "Router handshake protocol mismatch",
            502,
            "router_handshake_protocol_mismatch",
        )
    return payload


def _has_endpoint(payload: Dict[str, Any], name: str, method: str, path: str) -> bool:
    endpoint = as_record(as_record(payload.get("endpoints")).get(name))
    return endpoint.get("method") == method and endpoint.get("path") == path


def capabilities_from_probe(
    api_payload: Any,
    *,
    models_available: bool = False,
) -> tuple[str, ...]:
    """Derive truthful Router capabilities from the current local API probe.

    `models_available` must only be true after its concrete endpoint returned a
    valid response. Cron is advertised only when the API Server's plugin-safe
    contract explicitly enables jobs administration and enumerates every
    read/write/execute endpoint. A successful jobs-list probe alone remains
    intentionally insufficient.
    """

    payload = as_record(api_payload)
    features = as_record(payload.get("features"))
    available: set[str] = set()

    if _has_endpoint(payload, "health", "GET", "/health"):
        available.add("health")

    session_endpoints = (
        ("sessions", "GET", "/api/sessions"),
        ("session_create", "POST", "/api/sessions"),
        ("session", "GET", "/api/sessions/{session_id}"),
        ("session_update", "PATCH", "/api/sessions/{session_id}"),
        ("session_delete", "DELETE", "/api/sessions/{session_id}"),
        ("session_messages", "GET", "/api/sessions/{session_id}/messages"),
        ("session_fork", "POST", "/api/sessions/{session_id}/fork"),
    )
    sessions_available = (
        features.get("session_resources") is True
        and features.get("session_fork") is True
        and all(_has_endpoint(payload, name, method, path) for name, method, path in session_endpoints)
    )
    if sessions_available:
        available.update(("sessions", "sessions.usage"))

    run_endpoints = (
        ("runs", "POST", "/v1/runs"),
        ("run_status", "GET", "/v1/runs/{run_id}"),
        ("run_events", "GET", "/v1/runs/{run_id}/events"),
        ("run_stop", "POST", "/v1/runs/{run_id}/stop"),
    )
    stream_available = (
        sessions_available
        and features.get("run_submission") is True
        and features.get("run_status") is True
        and features.get("run_events_sse") is True
        and features.get("run_stop") is True
        and all(_has_endpoint(payload, name, method, path) for name, method, path in run_endpoints)
    )
    if stream_available:
        available.update(("chat.stream", "chat.message.delta", "chat.reasoning"))
        if features.get("tool_progress_events") is True:
            available.add("chat.tools")

    if stream_available:
        available.add("run.stop")

    if (
        stream_available
        and features.get("run_approval_response") is True
        and features.get("approval_events") is True
        and _has_endpoint(payload, "run_approval", "POST", "/v1/runs/{run_id}/approval")
    ):
        available.add("run.approval")

    if models_available and _has_endpoint(payload, "models", "GET", "/v1/models"):
        available.add("models")

    cron_endpoints = (
        ("jobs", "GET", "/api/jobs"),
        ("job_create", "POST", "/api/jobs"),
        ("job", "GET", "/api/jobs/{job_id}"),
        ("job_update", "PATCH", "/api/jobs/{job_id}"),
        ("job_delete", "DELETE", "/api/jobs/{job_id}"),
        ("job_pause", "POST", "/api/jobs/{job_id}/pause"),
        ("job_resume", "POST", "/api/jobs/{job_id}/resume"),
        ("job_run", "POST", "/api/jobs/{job_id}/run"),
    )
    if features.get("jobs_admin") is True and all(
        _has_endpoint(payload, name, method, path)
        for name, method, path in cron_endpoints
    ):
        available.add("cron")
    return tuple(item for item in CAPABILITY_ORDER if item in available)


def gateway_rpc_method(body: bytes) -> tuple[str, Dict[str, Any]]:
    payload = parse_json_body(body)
    method = payload.get("method")
    if not isinstance(method, str) or not method.strip():
        raise ProtocolError("Gateway RPC method is required")
    return method.strip(), as_record(payload.get("params"))


def model_options_payload(models_payload: Any) -> Dict[str, Any]:
    rows = as_record(models_payload).get("data")
    models: List[Dict[str, Any]] = []
    if isinstance(rows, list):
        for row in rows:
            item = as_record(row)
            model_id = item.get("id")
            if isinstance(model_id, str) and model_id.strip():
                models.append(
                    {
                        "id": model_id.strip(),
                        "name": model_id.strip(),
                        "provider": "hermes-hub-gateway",
                        "root": item.get("root") or model_id.strip(),
                    }
                )
    return {
        "providers": [
            {
                "id": "hermes-hub-gateway",
                "name": "Hermes Gateway",
                "models": models,
            }
        ],
        "models": models,
        "source": "hermes-api-server",
    }


def session_rows(payload: Any) -> List[Dict[str, Any]]:
    rows = as_record(payload).get("data")
    return [as_record(item) for item in rows] if isinstance(rows, list) else []


def conversation_history(messages_payload: Any) -> List[Dict[str, str]]:
    rows = as_record(messages_payload).get("data")
    if not isinstance(rows, list):
        return []
    output: List[Dict[str, str]] = []
    for row in rows:
        item = as_record(row)
        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant", "system", "tool"}:
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        # /v1/runs accepts role/content history. Tool rows are represented as
        # assistant-visible context because it does not accept tool_call_id.
        normalized_role = "assistant" if role == "tool" else role
        output.append({"role": normalized_role, "content": content})
    return output


def visible_input(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            row = as_record(item)
            text = row.get("text") or row.get("content")
            if isinstance(text, str):
                parts.append(text)
        return "\n".join(part for part in parts if part)
    return ""


def approval_choice(value: Any) -> str:
    raw = str(value or "").strip().lower()
    aliases = {
        "allow": "once",
        "approve": "once",
        "yes": "once",
        "once": "once",
        "session": "session",
        "always": "always",
        "deny": "deny",
        "reject": "deny",
        "no": "deny",
    }
    if raw not in aliases:
        raise ProtocolError("unsupported approval choice")
    return aliases[raw]


@dataclass
class SseEvent:
    event: str
    data: Dict[str, Any]


class SseParser:
    def __init__(self) -> None:
        self._event = "message"
        self._data: List[str] = []
        self._data_bytes = 0

    def feed_line(self, raw_line: bytes) -> Optional[SseEvent]:
        if len(raw_line) > MAX_EVENT_BYTES:
            raise ProtocolError("upstream SSE line is too large", 502, "event_too_large")
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            if not self._data:
                self._event = "message"
                return None
            text = "\n".join(self._data)
            self._data = []
            self._data_bytes = 0
            event = self._event
            self._event = "message"
            try:
                parsed = json.loads(text)
            except Exception:
                parsed = {"text": text}
            return SseEvent(event=event, data=as_record(parsed))
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            self._event = value.strip() or "message"
        elif field == "data":
            encoded_bytes = len(value.encode("utf-8"))
            separator_bytes = 1 if self._data else 0
            if self._data_bytes + separator_bytes + encoded_bytes > MAX_EVENT_BYTES:
                self._data = []
                self._data_bytes = 0
                self._event = "message"
                raise ProtocolError("upstream SSE event is too large", 502, "event_too_large")
            self._data.append(value)
            self._data_bytes += separator_bytes + encoded_bytes
        return None


def safe_error(value: BaseException | str) -> str:
    text = str(value)
    text = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [REDACTED]", text)
    text = re.sub(
        r"(?i)\b(https?|wss?)://[^/@\s:]+:[^/@\s]+@",
        r"\1://[REDACTED]@",
        text,
    )
    text = re.sub(
        r"(?i)([?&](?:access[_-]?token|token|api[_-]?key|secret|password)=)[^&#\s]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)(authorization|access[_-]?token|token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+",
        r"\1=[REDACTED]",
        text,
    )
    return text[:500] or "Gateway request failed"
