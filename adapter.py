"""Hermes Gateway lifecycle adapter for the Hermes Hub outbound transport."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit

import aiohttp

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, SendResult

from .protocol import (
    MAX_STREAM_OUTPUT_BYTES,
    MAX_RESPONSE_BODY_BYTES,
    MAX_WIRE_FRAME_BYTES,
    TERMINAL_RUN_STATUSES,
    ProtocolError,
    SseParser,
    approval_choice,
    as_record,
    capabilities_from_probe,
    conversation_history,
    decode_body_base64,
    encode_body_base64,
    gateway_hello,
    gateway_rpc_method,
    is_allowed_api_path,
    json_bytes,
    model_options_payload,
    normalized_path,
    parse_json_body,
    required_capability_for_api_path,
    safe_error,
    validate_router_handshake,
    visible_input,
)

logger = logging.getLogger(__name__)

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_HERMES_AGENT_ID_PATTERN = re.compile(r"agent_[A-Za-z0-9._:-]{2,154}")
_GATEWAY_ID_PATTERN = re.compile(r"gw_[A-Za-z0-9._:-]{5,157}")


def _positive_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _validate_url(
    value: str,
    *,
    label: str,
    schemes: set[str],
    loopback_only: bool = False,
    plaintext_loopback_only: bool = False,
) -> Any:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty URL without surrounding whitespace")
    parsed = urlsplit(value)
    if parsed.scheme not in schemes or not parsed.netloc or not parsed.hostname:
        allowed = "/".join(sorted(schemes))
        raise ValueError(f"{label} must use {allowed} with a host")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{label} must not contain credentials, query, or fragment")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(f"{label} has an invalid port") from exc
    host = parsed.hostname.lower()
    if loopback_only and host not in _LOOPBACK_HOSTS:
        raise ValueError(f"{label} must use a loopback host")
    if plaintext_loopback_only and parsed.scheme in {"http", "ws"} and host not in _LOOPBACK_HOSTS:
        raise ValueError(f"Non-loopback {label} must use an encrypted transport")
    return parsed


def _validate_router_url(value: str) -> None:
    _validate_url(
        value,
        label="Hermes Hub Router URL",
        schemes={"http", "https", "ws", "wss"},
        plaintext_loopback_only=True,
    )


def _gateway_stream_url(
    router_url: str,
    gateway_id: str,
    explicit_url: Optional[str] = None,
) -> str:
    explicit = explicit_url if explicit_url is not None else os.getenv("HERMES_HUB_GATEWAY_STREAM_URL", "")
    explicit = explicit.strip()
    if explicit:
        parsed = _validate_url(
            explicit,
            label="Hermes Hub Gateway stream URL",
            schemes={"ws", "wss"},
            plaintext_loopback_only=True,
        )
    else:
        _validate_router_url(router_url)
        parsed = urlsplit(router_url)
        scheme = "wss" if parsed.scheme in {"https", "wss"} else "ws"
        base_path = parsed.path.rstrip("/")
        path = f"{base_path}/router/hermes-hub-gateways/{quote(gateway_id, safe='')}/stream"
        parsed = parsed._replace(scheme=scheme, path=path, query="", fragment="")
    return urlunsplit(parsed)


def _validate_local_api_url(value: str) -> None:
    parsed = _validate_url(
        value,
        label="Local API URL",
        schemes={"http", "https"},
        loopback_only=True,
    )
    if parsed.path not in {"", "/"}:
        raise ValueError("Local API URL must not contain a path")


class HermesHubGatewayAdapter(BasePlatformAdapter):
    """Outbound Router tunnel owned by the Hermes Gateway process lifecycle."""

    # Requests have a bounded Router response stream. There is no platform
    # message channel on which Hermes can promise delivery after that stream
    # ends, matching the public API Server lifecycle.
    supports_async_delivery = False

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("hermes_hub_gateway"))
        extra = getattr(config, "extra", {}) or {}
        self.router_url = (os.getenv("HERMES_HUB_ROUTER_URL") or extra.get("router_url") or "").rstrip("/")
        self.hermes_agent_id = os.getenv("HERMES_HUB_AGENT_ID") or extra.get("hermes_agent_id") or ""
        self.gateway_id = os.getenv("HERMES_HUB_GATEWAY_ID") or extra.get("gateway_id") or ""
        self.router_token = os.getenv("HERMES_HUB_GATEWAY_TOKEN") or extra.get("gateway_token") or ""
        self.gateway_stream_url = (
            os.getenv("HERMES_HUB_GATEWAY_STREAM_URL")
            or extra.get("gateway_stream_url")
            or ""
        )
        self.api_url = (os.getenv("HERMES_HUB_LOCAL_API_URL") or extra.get("local_api_url") or "http://127.0.0.1:8642").rstrip("/")
        self.api_key = os.getenv("API_SERVER_KEY") or extra.get("api_server_key") or ""
        self.max_concurrency = _positive_int(
            os.getenv("HERMES_HUB_GATEWAY_MAX_CONCURRENCY") or extra.get("max_concurrency"),
            8,
            1,
            64,
        )
        self.request_timeout_seconds = _positive_int(
            os.getenv("HERMES_HUB_GATEWAY_REQUEST_TIMEOUT_SECONDS") or extra.get("request_timeout_seconds"),
            30,
            3,
            600,
        )
        self.handshake_timeout_seconds = _positive_int(
            os.getenv("HERMES_HUB_GATEWAY_HANDSHAKE_TIMEOUT_SECONDS")
            or extra.get("handshake_timeout_seconds"),
            10,
            1,
            30,
        )
        self.run_start_timeout_seconds = _positive_int(
            os.getenv("HERMES_HUB_GATEWAY_RUN_START_TIMEOUT_SECONDS")
            or extra.get("run_start_timeout_seconds"),
            min(self.request_timeout_seconds, 15),
            3,
            30,
        )
        self.stop_confirm_timeout_seconds = _positive_int(
            os.getenv("HERMES_HUB_GATEWAY_STOP_CONFIRM_TIMEOUT_SECONDS")
            or extra.get("stop_confirm_timeout_seconds"),
            8,
            1,
            30,
        )
        self._session: Optional[aiohttp.ClientSession] = None
        self._socket: Optional[aiohttp.ClientWebSocketResponse] = None
        self._receive_task: Optional[asyncio.Task] = None
        self._request_tasks: Dict[str, asyncio.Task] = {}
        self._stream_runs: Dict[str, str] = {}
        self._session_runs: Dict[str, str] = {}
        self._active_session_ids: set[str] = set()
        self._quarantined_sessions: Dict[str, Optional[str]] = {}
        self._pending_run_starts: Dict[str, asyncio.Task] = {}
        self._run_stop_tasks: Dict[str, asyncio.Task] = {}
        self._reconcile_tasks: Dict[str, asyncio.Task] = {}
        self._lifecycle_tasks: set[asyncio.Task] = set()
        self._send_lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(self.max_concurrency)
        self._disconnecting = False
        self.capabilities: tuple[str, ...] = ()

    @property
    def name(self) -> str:
        return "Hermes Hub Gateway"

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        config_error = _config_validation_error(self.config)
        if config_error is not None:
            code, message = config_error
            self._set_fatal_error(code, message, retryable=False)
            return False
        if not self._acquire_platform_lock(
            "hermes-hub-agent-id",
            self.hermes_agent_id,
            "Hermes Agent identity",
        ):
            return False

        self._disconnecting = False
        await self._close_transport()
        self.capabilities = ()
        timeout = aiohttp.ClientTimeout(total=None, connect=20, sock_connect=20, sock_read=None)
        self._session = aiohttp.ClientSession(timeout=timeout, raise_for_status=False)
        try:
            self.capabilities = await self._discover_capabilities()
            stream_url = _gateway_stream_url(
                self.router_url,
                self.gateway_id,
                self.gateway_stream_url,
            )
            self._socket = await self._session.ws_connect(
                stream_url,
                headers={
                    "Authorization": f"Bearer {self.router_token}",
                    "User-Agent": "hermes-hub-gateway-plugin/0.2",
                },
                heartbeat=20,
                autoping=True,
                max_msg_size=MAX_WIRE_FRAME_BYTES,
            )
            await self._perform_router_handshake()
        except asyncio.CancelledError:
            await self._close_transport()
            self._release_platform_lock()
            raise
        except ProtocolError as exc:
            await self._close_transport()
            self._release_platform_lock()
            self._set_fatal_error(exc.code, safe_error(exc), retryable=True)
            return False
        except Exception as exc:
            await self._close_transport()
            self._release_platform_lock()
            self._set_fatal_error("connect_failed", safe_error(exc), retryable=True)
            return False

        self._receive_task = asyncio.create_task(self._receive_loop())
        self._mark_connected()
        logger.info(
            "Hermes Hub Gateway connected (hermes_agent_id=%s, gateway_id=%s, reconnect=%s, capabilities=%d)",
            self.hermes_agent_id,
            self.gateway_id,
            is_reconnect,
            len(self.capabilities),
        )
        return True

    async def disconnect(self) -> None:
        self._disconnecting = True
        self._mark_disconnected()
        current = asyncio.current_task()
        receive_task = self._receive_task
        if receive_task and receive_task is not current and not receive_task.done():
            receive_task.cancel()
        tasks = list(self._request_tasks.values())
        for task in tasks:
            task.cancel()
        teardown_deadline = time.monotonic() + self.run_start_timeout_seconds + self.stop_confirm_timeout_seconds + 3
        pending_teardown = await self._wait_tasks_until(tasks, teardown_deadline)

        # A request may have been cancelled while its shielded loopback start
        # was waiting for the API Server's immediate 202 response.  Await the
        # compensation owner before closing the shared HTTP session.
        pending_teardown.update(
            await self._wait_tasks_until(list(self._lifecycle_tasks), teardown_deadline)
        )

        # Stop any run still known after request unwind.  Each stop confirms a
        # terminal GET status or leaves the session quarantined; teardown never
        # waits indefinitely for a broken local API Server.
        stop_tasks = [
            asyncio.create_task(self._stop_run(session_id, run_id))
            for session_id, run_id in list(self._session_runs.items())
        ]
        pending_teardown.update(await self._wait_tasks_until(stop_tasks, teardown_deadline))

        if receive_task and receive_task is not current:
            pending_teardown.update(
                await self._wait_tasks_until([receive_task], teardown_deadline)
            )
        for task in pending_teardown:
            if not task.done():
                task.cancel()
        for task in set(self._reconcile_tasks.values()) | self._lifecycle_tasks:
            if not task.done():
                task.cancel()
        await self._wait_tasks_until(
            list(self._reconcile_tasks.values()) + list(self._lifecycle_tasks),
            time.monotonic() + 1,
        )
        self._request_tasks.clear()
        self._stream_runs.clear()
        self._session_runs.clear()
        self._active_session_ids.clear()
        self._quarantined_sessions.clear()
        self._pending_run_starts.clear()
        self._run_stop_tasks.clear()
        self._reconcile_tasks.clear()
        self._lifecycle_tasks.clear()
        await self._close_transport()
        self._release_platform_lock()
        self._receive_task = None

    async def _close_transport(self) -> None:
        socket, self._socket = self._socket, None
        if socket and not socket.closed:
            try:
                await asyncio.wait_for(socket.close(), timeout=3)
            except Exception:
                pass
        session, self._session = self._session, None
        if session and not session.closed:
            try:
                await asyncio.wait_for(session.close(), timeout=3)
            except Exception:
                pass

    async def _wait_tasks_until(
        self,
        tasks: list[asyncio.Task],
        deadline: float,
    ) -> set[asyncio.Task]:
        pending = {task for task in tasks if task and not task.done()}
        if not pending:
            return set()
        remaining = max(0.0, deadline - time.monotonic())
        if remaining <= 0:
            return pending
        done, pending = await asyncio.wait(pending, timeout=remaining)
        for task in done:
            if task.cancelled():
                continue
            try:
                task.exception()
            except Exception:
                pass
        return pending

    async def _perform_router_handshake(self) -> None:
        deadline = time.monotonic() + self.handshake_timeout_seconds
        await self._receive_handshake_frame("ready", deadline)
        if not await self._send_json(
            gateway_hello(self.hermes_agent_id, self.gateway_id, self.capabilities)
        ):
            raise ProtocolError(
                "Router closed before Gateway hello",
                503,
                "router_handshake_closed",
            )
        await self._receive_handshake_frame("hello_ack", deadline)

    async def _receive_handshake_frame(self, expected_type: str, deadline: float) -> Dict[str, Any]:
        socket = self._socket
        if not socket or socket.closed:
            raise ProtocolError("Router handshake socket is closed", 503, "router_handshake_closed")
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProtocolError("Router handshake timed out", 504, "router_handshake_timeout")
            try:
                message = await asyncio.wait_for(socket.receive(), timeout=remaining)
            except asyncio.TimeoutError as exc:
                raise ProtocolError(
                    "Router handshake timed out",
                    504,
                    "router_handshake_timeout",
                ) from exc
            if message.type in {aiohttp.WSMsgType.PING, aiohttp.WSMsgType.PONG}:
                continue
            if message.type != aiohttp.WSMsgType.TEXT:
                raise ProtocolError(
                    "Router closed during handshake",
                    503,
                    "router_handshake_closed",
                )
            try:
                payload = json.loads(message.data)
            except Exception as exc:
                raise ProtocolError(
                    "Router handshake is not valid JSON",
                    502,
                    "router_handshake_invalid",
                ) from exc
            return validate_router_handshake(
                payload,
                expected_type=expected_type,
                hermes_agent_id=self.hermes_agent_id,
                gateway_id=self.gateway_id,
            )

    async def _discover_capabilities(self) -> tuple[str, ...]:
        status, _, raw = await self._api_request(
            "GET",
            "/v1/capabilities",
            timeout_seconds=min(self.request_timeout_seconds, 15),
        )
        if status >= 400:
            raise ProtocolError(
                "Hermes API Server capability probe failed",
                503,
                "api_capability_probe_failed",
            )
        try:
            api_payload = json.loads(raw or b"{}")
        except Exception as exc:
            raise ProtocolError(
                "Hermes API Server returned invalid capabilities",
                503,
                "api_capability_probe_invalid",
            ) from exc
        if not isinstance(api_payload, dict):
            raise ProtocolError(
                "Hermes API Server returned invalid capabilities",
                503,
                "api_capability_probe_invalid",
            )

        health_status, _, _ = await self._api_request(
            "GET",
            "/health",
            timeout_seconds=min(self.request_timeout_seconds, 10),
        )
        if health_status >= 400:
            raise ProtocolError("Hermes API Server is not healthy", 503, "api_server_unhealthy")

        models_available = False
        model_status, _, model_raw = await self._api_request(
            "GET",
            "/v1/models",
            timeout_seconds=min(self.request_timeout_seconds, 10),
        )
        if model_status < 400:
            try:
                models_available = bool(model_options_payload(json.loads(model_raw or b"{}")).get("models"))
            except Exception:
                models_available = False

        capabilities = capabilities_from_probe(
            api_payload,
            models_available=models_available,
        )
        if "health" not in capabilities:
            raise ProtocolError(
                "Hermes API Server does not advertise its health contract",
                503,
                "api_capability_contract_invalid",
            )
        logger.info(
            "Hermes Hub Gateway capability probe completed (capabilities=%s)",
            ",".join(capabilities),
        )
        return capabilities

    def _require_capability(self, capability: str) -> None:
        if capability not in self.capabilities:
            raise ProtocolError(
                f"Gateway capability is unavailable: {capability}",
                501,
                "capability_unsupported",
            )

    async def _receive_loop(self) -> None:
        try:
            assert self._socket is not None
            async for message in self._socket:
                if message.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_router_message(message.data)
                elif message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Hermes Hub Gateway receive loop failed: %s", safe_error(exc))
        finally:
            if not self._disconnecting:
                # A Router transport loss is a real disconnect, not only a
                # status change.  Unwind active requests while the loopback
                # API client is still available so accepted runs are stopped.
                await self.disconnect()
                self._set_fatal_error("router_disconnected", "Router connection closed", retryable=True)
                await self._notify_fatal_error()

    async def _handle_router_message(self, text: str) -> None:
        try:
            message = json.loads(text)
        except Exception:
            logger.warning("Hermes Hub Gateway ignored invalid Router JSON")
            return
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        request_id = message.get("id")
        if kind == "heartbeat" and isinstance(request_id, str):
            await self._send_json(
                {
                    "type": "heartbeat_ack",
                    "id": request_id,
                    "hermesAgentId": self.hermes_agent_id,
                    "gatewayId": self.gateway_id,
                    "receivedAt": int(time.time() * 1000),
                }
            )
            return
        if kind in {"ready", "hello_ack", "ack"}:
            return
        if kind == "rpc_stream_cancel" and isinstance(request_id, str):
            await self._cancel_request(request_id)
            return
        if kind not in {"rpc_request", "rpc_stream_request"} or not isinstance(request_id, str):
            return
        if request_id in self._request_tasks:
            await self._send_error(request_id, "duplicate request id", "duplicate_request", stream=kind == "rpc_stream_request")
            return
        task = asyncio.create_task(
            self._run_request(message, stream=kind == "rpc_stream_request")
        )
        self._request_tasks[request_id] = task
        task.add_done_callback(lambda _task, rid=request_id: self._request_tasks.pop(rid, None))

    async def _run_request(self, message: Dict[str, Any], *, stream: bool) -> None:
        request_id = str(message["id"])
        try:
            async with self._semaphore:
                if stream:
                    await self._handle_stream_request(message)
                else:
                    await self._handle_rpc_request(message)
        except asyncio.CancelledError:
            raise
        except ProtocolError as exc:
            await self._send_error(request_id, str(exc), exc.code, stream=stream, status=exc.status)
        except Exception as exc:
            logger.warning("Hermes Hub Gateway request failed (id=%s): %s", request_id, safe_error(exc))
            await self._send_error(request_id, "Gateway request failed", "gateway_error", stream=stream, status=502)

    async def _cancel_request(self, request_id: str) -> None:
        task = self._request_tasks.get(request_id)
        if task and not task.done():
            task.cancel()

    async def _send_json(self, payload: Dict[str, Any]) -> bool:
        socket = self._socket
        if not socket or socket.closed:
            return False
        wire = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(wire.encode("utf-8")) > MAX_WIRE_FRAME_BYTES:
            raise ProtocolError("Gateway WebSocket frame is too large", 502, "wire_frame_too_large")
        async with self._send_lock:
            await socket.send_str(wire)
        return True

    async def _send_error(
        self,
        request_id: str,
        message: str,
        code: str,
        *,
        stream: bool,
        status: int = 502,
    ) -> None:
        if stream:
            await self._send_json(
                {
                    "type": "rpc_stream_error",
                    "id": request_id,
                    "error": message,
                    "code": code,
                    "status": status,
                    "sentAt": int(time.time() * 1000),
                }
            )
        else:
            body = json_bytes({"error": message, "code": code})
            await self._send_json(
                {
                    "type": "rpc_response",
                    "id": request_id,
                    "status": status,
                    "headers": {"content-type": "application/json; charset=utf-8"},
                    "bodyBase64": encode_body_base64(body),
                }
            )

    def _api_headers(self, content_type: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": "hermes-hub-gateway-plugin/0.2",
        }
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    async def _api_request(
        self,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        timeout_seconds: Optional[int] = None,
    ) -> tuple[int, Dict[str, str], bytes]:
        if not self._session or self._session.closed:
            raise ProtocolError("Gateway HTTP client is closed", 503, "transport_closed")
        path = normalized_path(path)
        url = f"{self.api_url}{path}"
        timeout = aiohttp.ClientTimeout(total=timeout_seconds or self.request_timeout_seconds)
        async with self._session.request(
            method.upper(),
            url,
            data=body or None,
            headers=self._api_headers("application/json" if body else None),
            timeout=timeout,
            allow_redirects=False,
        ) as response:
            data = await response.content.read(MAX_RESPONSE_BODY_BYTES + 1)
            if len(data) > MAX_RESPONSE_BODY_BYTES:
                raise ProtocolError("upstream response is too large", 502, "response_too_large")
            headers = {
                "content-type": response.headers.get("content-type", "application/octet-stream"),
            }
            session_header = response.headers.get("x-hermes-session-id")
            if session_header:
                headers["x-hermes-session-id"] = session_header[:256]
            return response.status, headers, data

    async def _handle_rpc_request(self, message: Dict[str, Any]) -> None:
        request_id = str(message["id"])
        method = str(message.get("method") or "GET").upper()
        path = normalized_path(message.get("path"))
        body = decode_body_base64(message.get("bodyBase64"))
        timeout_ms = _positive_int(message.get("timeoutMs"), self.request_timeout_seconds * 1000, 1000, 600000)

        if path.split("?", 1)[0] == "/api/ws":
            status, headers, response_body = await self._handle_gateway_rpc(body, timeout_ms)
        elif path.split("?", 1)[0] == "/api/session/usage":
            self._require_capability("sessions.usage")
            query = parse_qs(urlsplit(path).query)
            session_id = (query.get("session_id") or [""])[0]
            status, headers, response_body = await self._session_usage(session_id)
        elif path.split("?", 1)[0] == "/api/model/options":
            self._require_capability("models")
            status, headers, raw = await self._api_request("GET", "/v1/models")
            response_body = json_bytes(model_options_payload(json.loads(raw or b"{}"))) if status < 400 else raw
        elif is_allowed_api_path(path, method):
            required = required_capability_for_api_path(path)
            if not required:
                raise ProtocolError("operation is not exposed by Hermes Gateway", 501, "capability_unsupported")
            self._require_capability(required)
            status, headers, response_body = await self._api_request(
                method,
                path,
                body=body,
                timeout_seconds=max(1, timeout_ms // 1000),
            )
            response_body = self._compat_response(path, status, response_body)
        else:
            raise ProtocolError("operation is not exposed by Hermes Gateway", 501, "capability_unsupported")

        await self._send_json(
            {
                "type": "rpc_response",
                "id": request_id,
                "status": status,
                "headers": headers,
                "bodyBase64": encode_body_base64(response_body),
            }
        )

    def _compat_response(self, path: str, status: int, body: bytes) -> bytes:
        if status >= 400 or not body:
            return body
        try:
            payload = json.loads(body)
        except Exception:
            return body
        pathname = path.split("?", 1)[0]
        if pathname == "/api/sessions" and isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload.setdefault("sessions", payload["data"])
        elif pathname.endswith("/messages") and isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload.setdefault("messages", payload["data"])
        return json_bytes(payload)

    async def _handle_gateway_rpc(self, body: bytes, timeout_ms: int) -> tuple[int, Dict[str, str], bytes]:
        method, params = gateway_rpc_method(body)
        headers = {"content-type": "application/json; charset=utf-8"}
        if method == "model.options":
            self._require_capability("models")
            status, _, raw = await self._api_request("GET", "/v1/models")
            if status >= 400:
                return status, headers, raw
            return 200, headers, json_bytes(model_options_payload(json.loads(raw or b"{}")))
        if method in {"session.usage", "session.context_breakdown"}:
            self._require_capability("sessions.usage")
            status, _, usage = await self._session_usage(str(params.get("session_id") or ""))
            if method == "session.context_breakdown" and status < 400:
                payload = json.loads(usage or b"{}")
                payload.update({"estimated": True, "source": "hermes-api-server-session"})
                usage = json_bytes(payload)
            return status, headers, usage
        if method == "session.interrupt":
            self._require_capability("run.stop")
            session_id = str(params.get("session_id") or "")
            run_id = self._session_runs.get(session_id)
            if not run_id:
                return 409, headers, json_bytes({"error": "No active Gateway run for session", "code": "run_not_active"})
            terminal = await self._stop_run(session_id, run_id)
            if terminal is not None:
                return 200, headers, json_bytes(
                    {
                        "run_id": run_id,
                        "status": terminal.get("status"),
                        "terminal": True,
                    }
                )
            return 202, headers, json_bytes(
                {
                    "run_id": run_id,
                    "status": "stopping",
                    "terminal": False,
                    "session_busy": True,
                }
            )
        if method == "approval.respond":
            self._require_capability("run.approval")
            run_id = str(params.get("run_id") or params.get("request_id") or "")
            if not run_id:
                run_id = self._session_runs.get(str(params.get("session_id") or ""), "")
            if not run_id:
                return 409, headers, json_bytes({"error": "No active approval run", "code": "run_not_active"})
            choice = approval_choice(params.get("choice") or params.get("decision") or params.get("value"))
            status, _, response = await self._api_request(
                "POST",
                f"/v1/runs/{quote(run_id, safe='')}/approval",
                body=json_bytes({"choice": choice}),
                timeout_seconds=max(1, timeout_ms // 1000),
            )
            return status, headers, response
        return 501, headers, json_bytes(
            {"error": f"Gateway RPC method is not supported: {method}", "code": "capability_unsupported"}
        )

    async def _session_usage(self, session_id: str) -> tuple[int, Dict[str, str], bytes]:
        headers = {"content-type": "application/json; charset=utf-8"}
        if not session_id:
            return 400, headers, json_bytes({"error": "session_id is required"})
        status, _, raw = await self._api_request("GET", f"/api/sessions/{quote(session_id, safe='')}")
        if status >= 400:
            return status, headers, raw
        session = as_record(as_record(json.loads(raw or b"{}")).get("session"))
        input_tokens = int(session.get("input_tokens") or 0)
        output_tokens = int(session.get("output_tokens") or 0)
        cache_read_tokens = int(session.get("cache_read_tokens") or 0)
        cache_write_tokens = int(session.get("cache_write_tokens") or 0)
        return 200, headers, json_bytes(
            {
                "session_id": session_id,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "total_tokens": input_tokens + output_tokens,
                "reasoning_tokens": int(session.get("reasoning_tokens") or 0),
            }
        )

    async def _ensure_session(self, requested_id: str, request: Dict[str, Any]) -> str:
        session_id = requested_id or f"hub_{int(time.time())}_{uuid.uuid4().hex[:10]}"
        status, _, _ = await self._api_request("GET", f"/api/sessions/{quote(session_id, safe='')}")
        if status == 404:
            create_body = {
                "id": session_id,
                **({"model": request["model"]} if isinstance(request.get("model"), str) else {}),
                **({"title": request["title"]} if isinstance(request.get("title"), str) else {}),
            }
            status, _, _ = await self._api_request("POST", "/api/sessions", body=json_bytes(create_body))
            if status == 409:
                status, _, _ = await self._api_request("GET", f"/api/sessions/{quote(session_id, safe='')}")
            if status >= 400:
                raise ProtocolError("could not create Gateway session", status, "session_create_failed")
        elif status >= 400:
            raise ProtocolError("could not read Gateway session", status, "session_read_failed")
        return session_id

    async def _handle_stream_request(self, message: Dict[str, Any]) -> None:
        path = normalized_path(message.get("path"))
        if path.split("?", 1)[0] != "/api/chat-run/runs":
            raise ProtocolError("stream operation is not exposed by Hermes Gateway", 501, "capability_unsupported")
        self._require_capability("chat.stream")
        request = parse_json_body(decode_body_base64(message.get("bodyBase64")))
        prompt = visible_input(request.get("input") or request.get("message") or request.get("prompt"))
        if not prompt.strip():
            raise ProtocolError("chat stream input is required")
        session_id = await self._ensure_session(str(request.get("session_id") or "").strip(), request)

        if session_id in self._active_session_ids or session_id in self._quarantined_sessions:
            raise ProtocolError("session already has an active Gateway run", 409, "session_busy")
        self._active_session_ids.add(session_id)
        try:
            await self._stream_session(message, request, prompt, session_id)
        except asyncio.CancelledError:
            run_id = self._session_runs.get(session_id)
            if run_id and session_id not in self._quarantined_sessions:
                await self._stop_run(session_id, run_id)
            raise
        except Exception:
            run_id = self._session_runs.get(session_id)
            if run_id and session_id not in self._quarantined_sessions:
                await self._stop_run(session_id, run_id)
            raise
        finally:
            if (
                session_id not in self._quarantined_sessions
                and session_id not in self._session_runs
            ):
                self._active_session_ids.discard(session_id)

    def _track_lifecycle_task(self, task: asyncio.Task) -> asyncio.Task:
        self._lifecycle_tasks.add(task)
        task.add_done_callback(self._lifecycle_tasks.discard)
        return task

    def _quarantine_session(self, session_id: str, run_id: Optional[str]) -> None:
        self._active_session_ids.add(session_id)
        current = self._quarantined_sessions.get(session_id)
        if current and not run_id:
            return
        self._quarantined_sessions[session_id] = run_id

    def _register_run(self, request_id: str, session_id: str, run_id: str) -> None:
        self._stream_runs[request_id] = run_id
        self._session_runs[session_id] = run_id
        if session_id in self._quarantined_sessions:
            self._quarantined_sessions[session_id] = run_id

    def _release_session_run(self, session_id: str, run_id: str) -> None:
        if self._session_runs.get(session_id) == run_id:
            self._session_runs.pop(session_id, None)
        quarantined_run = self._quarantined_sessions.get(session_id)
        if quarantined_run in {None, run_id}:
            self._quarantined_sessions.pop(session_id, None)
        self._active_session_ids.discard(session_id)

    @staticmethod
    def _run_start_result(result: tuple[int, Dict[str, str], bytes]) -> str:
        status, _, raw = result
        try:
            payload = as_record(json.loads(raw or b"{}"))
        except Exception as exc:
            raise ProtocolError(
                "Hermes Gateway run returned invalid start data",
                502,
                "run_start_invalid",
            ) from exc
        run_id = str(payload.get("run_id") or "")
        if status >= 400 or not run_id:
            raise ProtocolError(
                "Hermes Gateway run did not start",
                status if status >= 400 else 502,
                "run_start_failed",
            )
        return run_id

    async def _start_run(
        self,
        request_id: str,
        session_id: str,
        run_body: Dict[str, Any],
    ) -> str:
        start_task = asyncio.create_task(
            self._api_request(
                "POST",
                "/v1/runs",
                body=json_bytes(run_body),
                timeout_seconds=self.run_start_timeout_seconds,
            )
        )
        self._pending_run_starts[request_id] = start_task
        try:
            try:
                result = await asyncio.shield(start_task)
            except asyncio.CancelledError:
                # The loopback API may already have accepted the run.  A
                # detached owner must collect its 202/run_id and compensate
                # with stop even if this Router request or adapter teardown is
                # cancelled again while unwinding.
                self._quarantine_session(session_id, None)
                compensation = self._track_lifecycle_task(
                    asyncio.create_task(
                        self._finish_cancelled_start(
                            request_id,
                            session_id,
                            start_task,
                        )
                    )
                )
                try:
                    await asyncio.shield(compensation)
                except asyncio.CancelledError:
                    pass
                raise
            run_id = self._run_start_result(result)
            self._register_run(request_id, session_id, run_id)
            return run_id
        finally:
            if self._pending_run_starts.get(request_id) is start_task and start_task.done():
                self._pending_run_starts.pop(request_id, None)

    async def _finish_cancelled_start(
        self,
        request_id: str,
        session_id: str,
        start_task: asyncio.Task,
    ) -> None:
        try:
            result = await asyncio.shield(start_task)
            run_id = self._run_start_result(result)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._quarantined_sessions.pop(session_id, None)
            self._active_session_ids.discard(session_id)
            return
        finally:
            if self._pending_run_starts.get(request_id) is start_task and start_task.done():
                self._pending_run_starts.pop(request_id, None)
        self._register_run(request_id, session_id, run_id)
        self._quarantine_session(session_id, run_id)
        await self._stop_run(session_id, run_id)

    async def _stream_session(
        self,
        message: Dict[str, Any],
        request: Dict[str, Any],
        prompt: str,
        session_id: str,
    ) -> None:
        request_id = str(message["id"])

        history_status, _, history_raw = await self._api_request(
            "GET", f"/api/sessions/{quote(session_id, safe='')}/messages"
        )
        history = conversation_history(json.loads(history_raw or b"{}")) if history_status < 400 else []
        run_body: Dict[str, Any] = {
            "input": prompt,
            "session_id": session_id,
            "conversation_history": history,
        }
        for key in ("model", "instructions"):
            if isinstance(request.get(key), str) and request[key].strip():
                run_body[key] = request[key].strip()
        if isinstance(request.get("system_message"), str) and request["system_message"].strip():
            run_body["instructions"] = request["system_message"].strip()

        timeout_ms = _positive_int(message.get("timeoutMs") or request.get("timeout_ms"), 1800000, 1000, 3600000)
        run_id = await self._start_run(request_id, session_id, run_body)
        started_at = time.monotonic()
        event_count = 0
        output = ""
        output_bytes = 0
        terminal_record: Optional[Dict[str, Any]] = None
        try:
            await self._send_stream_chunk(request_id, "run.started", {"run_id": run_id, "session_id": session_id})
            event_count += 1
            if not self._session or self._session.closed:
                raise ProtocolError("Gateway HTTP client is closed", 503, "transport_closed")
            timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000, connect=20, sock_connect=20, sock_read=None)
            async with self._session.get(
                f"{self.api_url}/v1/runs/{quote(run_id, safe='')}/events",
                headers={**self._api_headers(), "Accept": "text/event-stream"},
                timeout=timeout,
                allow_redirects=False,
            ) as response:
                if response.status >= 400:
                    raise ProtocolError("Hermes Gateway event stream rejected", response.status, "event_stream_rejected")
                parser = SseParser()
                while True:
                    line = await response.content.readline()
                    if not line:
                        break
                    event = parser.feed_line(line)
                    if not event:
                        continue
                    data = dict(event.data)
                    event_name = str(data.get("event") or event.event or "message")
                    data.setdefault("event", event_name)
                    data.setdefault("run_id", run_id)
                    data.setdefault("session_id", session_id)
                    if event_name.startswith("tool.") and "tool_name" not in data and isinstance(data.get("tool"), str):
                        data["tool_name"] = data["tool"]
                    if event_name == "approval.request":
                        data.setdefault("request_id", run_id)
                    if event_name == "message.delta":
                        delta = data.get("delta")
                        if isinstance(delta, str):
                            output_bytes += len(delta.encode("utf-8"))
                            if output_bytes > MAX_STREAM_OUTPUT_BYTES:
                                raise ProtocolError(
                                    "Hermes run output is too large",
                                    502,
                                    "output_too_large",
                                )
                            output += delta
                    terminal_status = event_name.removeprefix("run.")
                    if terminal_status in TERMINAL_RUN_STATUSES:
                        data.setdefault("status", terminal_status)
                        if isinstance(data.get("output"), str):
                            output = data["output"]
                            output_bytes = len(output.encode("utf-8"))
                            if output_bytes > MAX_STREAM_OUTPUT_BYTES:
                                raise ProtocolError(
                                    "Hermes run output is too large",
                                    502,
                                    "output_too_large",
                                )
                        terminal_record = data
                        event_count += await self._send_terminal_chunks(
                            request_id,
                            run_id,
                            session_id,
                            terminal_status,
                            terminal_record,
                            output,
                        )
                        # A terminal run event owns the end of the run stream.
                        # Ignore any buggy/later upstream frames.
                        break
                    await self._send_stream_chunk(request_id, event_name, data)
                    event_count += 1
        except asyncio.CancelledError:
            await self._stop_run(session_id, run_id)
            raise
        except Exception:
            if terminal_record is None:
                await self._stop_run(session_id, run_id)
            raise
        finally:
            self._stream_runs.pop(request_id, None)
            if str((terminal_record or {}).get("status") or "") in TERMINAL_RUN_STATUSES:
                self._release_session_run(session_id, run_id)

        if terminal_record is None:
            terminal_record = await self._poll_run_until_terminal(run_id, timeout_seconds=1)
            if terminal_record is None:
                terminal_record = await self._stop_run(session_id, run_id)
            if terminal_record is not None:
                terminal = str(terminal_record.get("status") or "failed")
                if isinstance(terminal_record.get("output"), str):
                    output = terminal_record["output"]
                    if len(output.encode("utf-8")) > MAX_STREAM_OUTPUT_BYTES:
                        raise ProtocolError(
                            "Hermes run output is too large",
                            502,
                            "output_too_large",
                        )
                event_count += await self._send_terminal_chunks(
                    request_id,
                    run_id,
                    session_id,
                    terminal,
                    terminal_record,
                    output,
                )
        terminal = str((terminal_record or {}).get("status") or "stopping")
        if terminal in TERMINAL_RUN_STATUSES:
            self._release_session_run(session_id, run_id)
        final_status = 200 if terminal == "completed" else 499 if terminal == "cancelled" else 502
        final_body = json_bytes(
            {
                "ok": final_status == 200,
                "session_id": session_id,
                "run_id": run_id,
                "status": terminal,
                "output": output,
            }
        )
        await self._send_json(
            {
                "type": "rpc_stream_end",
                "id": request_id,
                "status": final_status,
                "headers": {"content-type": "application/json; charset=utf-8"},
                "bodyBase64": encode_body_base64(final_body),
                "sentAt": int(time.time() * 1000),
                "metrics": {
                    "streamedEventCount": event_count,
                    "upstreamHermesLatencyMs": int((time.monotonic() - started_at) * 1000),
                    "upstreamContentType": "text/event-stream",
                    "upstreamResponseBytes": len(final_body),
                },
            }
        )

    async def _send_terminal_chunks(
        self,
        request_id: str,
        run_id: str,
        session_id: str,
        terminal: str,
        record: Dict[str, Any],
        output: str,
    ) -> int:
        if terminal not in TERMINAL_RUN_STATUSES:
            return 0
        sent = 0
        if terminal == "completed":
            await self._send_stream_chunk(
                request_id,
                "message.complete",
                {
                    "run_id": run_id,
                    "session_id": session_id,
                    "text": output,
                    "content": output,
                },
            )
            sent += 1
        data = dict(record)
        event_name = f"run.{terminal}"
        data["event"] = event_name
        data.setdefault("run_id", run_id)
        data.setdefault("session_id", session_id)
        await self._send_stream_chunk(request_id, event_name, data)
        return sent + 1

    async def _send_stream_chunk(self, request_id: str, event: str, data: Dict[str, Any]) -> None:
        await self._send_json(
            {
                "type": "rpc_stream_chunk",
                "id": request_id,
                "event": event,
                "data": data,
                "sentAt": int(time.time() * 1000),
            }
        )

    async def _stop_stream_run(self, request_id: str) -> None:
        run_id = self._stream_runs.get(request_id)
        if not run_id:
            return
        session_id = next(
            (sid for sid, active_run_id in self._session_runs.items() if active_run_id == run_id),
            "",
        )
        if session_id:
            await self._stop_run(session_id, run_id)

    async def _stop_run(self, session_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        existing = self._run_stop_tasks.get(run_id)
        if existing is None or existing.done():
            task = self._track_lifecycle_task(
                asyncio.create_task(self._stop_run_once(session_id, run_id))
            )
            self._run_stop_tasks[run_id] = task

            def _discard(done: asyncio.Task, rid: str = run_id) -> None:
                if self._run_stop_tasks.get(rid) is done:
                    self._run_stop_tasks.pop(rid, None)

            task.add_done_callback(_discard)
            existing = task
        return await asyncio.shield(existing)

    async def _stop_run_once(self, session_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        self._quarantine_session(session_id, run_id)
        await self._request_run_stop(run_id)
        terminal = await self._poll_run_until_terminal(
            run_id,
            timeout_seconds=self.stop_confirm_timeout_seconds,
        )
        if terminal is not None:
            self._release_session_run(session_id, run_id)
            return terminal
        if not self._disconnecting:
            self._start_reconcile(session_id, run_id)
        return None

    async def _request_run_stop(self, run_id: str) -> None:
        try:
            await self._api_request(
                "POST",
                f"/v1/runs/{quote(run_id, safe='')}/stop",
                body=b"{}",
                timeout_seconds=min(5, self.stop_confirm_timeout_seconds),
            )
        except Exception:
            logger.debug("Gateway run stop request failed (run_id=%s)", run_id, exc_info=True)

    async def _poll_run_until_terminal(
        self,
        run_id: str,
        *,
        timeout_seconds: float,
    ) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        first = True
        while first or time.monotonic() < deadline:
            first = False
            remaining = max(0.1, deadline - time.monotonic())
            try:
                status, _, raw = await self._api_request(
                    "GET",
                    f"/v1/runs/{quote(run_id, safe='')}",
                    timeout_seconds=max(1, min(5, int(remaining + 0.999))),
                )
                payload = as_record(json.loads(raw or b"{}")) if status < 400 else {}
                if str(payload.get("status") or "") in TERMINAL_RUN_STATUSES:
                    return payload
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("Gateway run terminal poll failed (run_id=%s)", run_id, exc_info=True)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(0.25, remaining))
        return None

    def _start_reconcile(self, session_id: str, run_id: str) -> None:
        existing = self._reconcile_tasks.get(session_id)
        if existing and not existing.done():
            return
        task = self._track_lifecycle_task(
            asyncio.create_task(self._reconcile_until_terminal(session_id, run_id))
        )
        self._reconcile_tasks[session_id] = task

        def _discard(done: asyncio.Task, sid: str = session_id) -> None:
            if self._reconcile_tasks.get(sid) is done:
                self._reconcile_tasks.pop(sid, None)

        task.add_done_callback(_discard)

    async def _reconcile_until_terminal(self, session_id: str, run_id: str) -> None:
        delay = 0.5
        while not self._disconnecting and self._session_runs.get(session_id) == run_id:
            await self._request_run_stop(run_id)
            terminal = await self._poll_run_until_terminal(run_id, timeout_seconds=0)
            if terminal is not None:
                self._release_session_run(session_id, run_id)
                return
            await asyncio.sleep(delay)
            delay = min(5.0, delay * 2)

    # BasePlatformAdapter requires messaging send methods. Hermes Hub uses the
    # RPC tunnel above, so these remain intentionally unavailable.
    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata=None):
        return SendResult(success=False, error="Hermes Hub Gateway uses the Router RPC transport")

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "remote", "chat_id": chat_id}


def _config_value(config, env_name: str, extra_name: str, default: Any = "") -> Any:
    extra = getattr(config, "extra", {}) or {}
    env_value = os.getenv(env_name)
    if env_value:
        return env_value
    extra_value = extra.get(extra_name)
    return default if extra_value is None or extra_value == "" else extra_value


def _required_values(config=None) -> tuple[Any, Any, Any, Any, Any]:
    return (
        _config_value(config, "HERMES_HUB_ROUTER_URL", "router_url"),
        _config_value(config, "HERMES_HUB_AGENT_ID", "hermes_agent_id"),
        _config_value(config, "HERMES_HUB_GATEWAY_ID", "gateway_id"),
        _config_value(config, "HERMES_HUB_GATEWAY_TOKEN", "gateway_token"),
        _config_value(config, "API_SERVER_KEY", "api_server_key"),
    )


def check_requirements() -> bool:
    """Return whether import-time dependencies are available.

    Runtime credentials intentionally do not participate here. Hermes invokes
    this zero-argument hook before it has merged ``PlatformConfig.extra``.
    ``aiohttp`` is imported by this module, so reaching the hook proves the
    dependency is importable; the attribute guard also catches a broken stub.
    """

    return hasattr(aiohttp, "ClientSession")


def _invalid_secret(value: Any, *, minimum: int) -> bool:
    return (
        not isinstance(value, str)
        or len(value) < minimum
        or len(value) > 512
        or any(character.isspace() for character in value)
    )


def _bounded_integer_error(
    config,
    env_name: str,
    extra_name: str,
    label: str,
    minimum: int,
    maximum: int,
) -> Optional[str]:
    value = _config_value(config, env_name, extra_name, None)
    if value is None:
        return None
    if isinstance(value, bool):
        return f"{label} must be an integer from {minimum} to {maximum}"
    try:
        parsed = int(str(value).strip(), 10)
    except (TypeError, ValueError):
        return f"{label} must be an integer from {minimum} to {maximum}"
    if parsed < minimum or parsed > maximum:
        return f"{label} must be from {minimum} to {maximum}"
    return None


def _config_validation_error(config) -> Optional[tuple[str, str]]:
    router_url, hermes_agent_id, gateway_id, gateway_token, api_key = _required_values(config)
    required = (
        ("Router URL", router_url),
        ("Hermes Agent id", hermes_agent_id),
        ("Gateway id", gateway_id),
        ("Gateway token", gateway_token),
        ("API_SERVER_KEY", api_key),
    )
    missing = [label for label, value in required if not isinstance(value, str) or not value.strip()]
    if missing:
        return "config_missing", f"Required Gateway configuration is missing: {', '.join(missing)}"

    if os.getenv("API_SERVER_ENABLED", "").strip().lower() not in _TRUTHY_VALUES:
        return "api_server_disabled", "API_SERVER_ENABLED must be true"

    if not _HERMES_AGENT_ID_PATTERN.fullmatch(hermes_agent_id):
        return "identity_invalid", "Hermes Agent id must use the agent_ identity format"
    if not _GATEWAY_ID_PATTERN.fullmatch(gateway_id):
        return "identity_invalid", "Gateway id must use the gw_ identity format"
    if _invalid_secret(gateway_token, minimum=43):
        return "gateway_credential_invalid", "Gateway token must be a strong whitespace-free credential"
    if _invalid_secret(api_key, minimum=16):
        return "api_server_key_invalid", "API_SERVER_KEY must be a strong whitespace-free credential"

    explicit_stream_url = _config_value(
        config,
        "HERMES_HUB_GATEWAY_STREAM_URL",
        "gateway_stream_url",
    )
    try:
        _gateway_stream_url(router_url, gateway_id, explicit_stream_url)
    except (AttributeError, TypeError, ValueError) as exc:
        return "router_url_invalid", str(exc)

    local_api_url = _config_value(
        config,
        "HERMES_HUB_LOCAL_API_URL",
        "local_api_url",
        "http://127.0.0.1:8642",
    )
    try:
        _validate_local_api_url(local_api_url)
    except (TypeError, ValueError) as exc:
        return "api_server_url_invalid", str(exc)

    bounded_values = (
        (
            "HERMES_HUB_GATEWAY_MAX_CONCURRENCY",
            "max_concurrency",
            "Gateway max concurrency",
            1,
            64,
        ),
        (
            "HERMES_HUB_GATEWAY_REQUEST_TIMEOUT_SECONDS",
            "request_timeout_seconds",
            "Gateway request timeout",
            3,
            600,
        ),
        (
            "HERMES_HUB_GATEWAY_HANDSHAKE_TIMEOUT_SECONDS",
            "handshake_timeout_seconds",
            "Gateway handshake timeout",
            1,
            30,
        ),
        (
            "HERMES_HUB_GATEWAY_RUN_START_TIMEOUT_SECONDS",
            "run_start_timeout_seconds",
            "Gateway run-start timeout",
            3,
            30,
        ),
        (
            "HERMES_HUB_GATEWAY_STOP_CONFIRM_TIMEOUT_SECONDS",
            "stop_confirm_timeout_seconds",
            "Gateway stop-confirm timeout",
            1,
            30,
        ),
    )
    for env_name, extra_name, label, minimum, maximum in bounded_values:
        error = _bounded_integer_error(
            config,
            env_name,
            extra_name,
            label,
            minimum,
            maximum,
        )
        if error:
            return "config_value_invalid", error
    return None


def validate_config(config) -> bool:
    return _config_validation_error(config) is None


def is_configured(config) -> bool:
    return validate_config(config)


def is_connected(config) -> bool:
    return is_configured(config)


def _env_enablement() -> Optional[dict]:
    router_url, hermes_agent_id, gateway_id, gateway_token, api_key = _required_values()
    if not all((router_url, hermes_agent_id, gateway_id, gateway_token, api_key)):
        return None
    return {
        "router_url": router_url,
        "hermes_agent_id": hermes_agent_id,
        "gateway_id": gateway_id,
        "gateway_token": gateway_token,
        "api_server_key": api_key,
        "local_api_url": os.getenv("HERMES_HUB_LOCAL_API_URL", "http://127.0.0.1:8642"),
    }


def register(ctx):
    ctx.register_platform(
        name="hermes_hub_gateway",
        label="Hermes Hub Gateway",
        adapter_factory=lambda cfg: HermesHubGatewayAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[
            "HERMES_HUB_ROUTER_URL",
            "HERMES_HUB_AGENT_ID",
            "HERMES_HUB_GATEWAY_ID",
            "HERMES_HUB_GATEWAY_TOKEN",
            "API_SERVER_ENABLED",
            "API_SERVER_KEY",
        ],
        install_hint="Install the Hermes Hub Gateway Plugin and enable Hermes API Server",
        env_enablement_fn=_env_enablement,
        emoji="🔗",
        pii_safe=False,
        allow_update_command=False,
        platform_hint=(
            "Hermes Hub is a remote client transport. Preserve structured events and "
            "do not include secrets, tokens, or local paths in user-facing output."
        ),
    )
