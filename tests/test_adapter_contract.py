import asyncio
import base64
import importlib.util
import json
import os
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "_hermes_hub_gateway_contract_test"


def load_adapter_module():
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package

    gateway_names = ("gateway", "gateway.config", "gateway.platforms", "gateway.platforms.base")
    missing = object()
    previous = {name: sys.modules.get(name, missing) for name in gateway_names}
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []
    gateway_config = types.ModuleType("gateway.config")
    gateway_platforms = types.ModuleType("gateway.platforms")
    gateway_platforms.__path__ = []
    gateway_base = types.ModuleType("gateway.platforms.base")

    class Platform:
        def __init__(self, value):
            self.value = value

    class BasePlatformAdapter:
        def __init__(self, config, platform):
            self.config = config
            self.platform = platform
            self._running = False
            self.fatal_error_code = None
            self.lock_identity = None

        def _acquire_platform_lock(self, scope, identity, _description):
            self.lock_scope = scope
            self.lock_identity = identity
            return True

        def _release_platform_lock(self):
            self.lock_identity = None

        def _mark_connected(self):
            self._running = True

        def _mark_disconnected(self):
            self._running = False

        def _set_fatal_error(self, code, _message, *, retryable):
            self._running = False
            self.fatal_error_code = code
            self.fatal_error_retryable = retryable

        async def _notify_fatal_error(self):
            return None

    class SendResult:
        def __init__(self, success, error=None):
            self.success = success
            self.error = error

    gateway_config.Platform = Platform
    gateway_base.BasePlatformAdapter = BasePlatformAdapter
    gateway_base.SendResult = SendResult
    sys.modules["gateway"] = gateway
    sys.modules["gateway.config"] = gateway_config
    sys.modules["gateway.platforms"] = gateway_platforms
    sys.modules["gateway.platforms.base"] = gateway_base

    try:
        protocol_spec = importlib.util.spec_from_file_location(f"{PACKAGE}.protocol", ROOT / "protocol.py")
        protocol = importlib.util.module_from_spec(protocol_spec)
        sys.modules[protocol_spec.name] = protocol
        protocol_spec.loader.exec_module(protocol)

        adapter_spec = importlib.util.spec_from_file_location(f"{PACKAGE}.adapter", ROOT / "adapter.py")
        adapter = importlib.util.module_from_spec(adapter_spec)
        sys.modules[adapter_spec.name] = adapter
        adapter_spec.loader.exec_module(adapter)
        return adapter, protocol
    finally:
        for name, value in previous.items():
            if value is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


adapter_module, protocol_module = load_adapter_module()


def runtime_adapter():
    adapter = object.__new__(adapter_module.HermesHubGatewayAdapter)
    adapter._stream_runs = {}
    adapter._session_runs = {}
    adapter._active_session_ids = set()
    adapter._quarantined_sessions = {}
    adapter._pending_run_starts = {}
    adapter._run_stop_tasks = {}
    adapter._reconcile_tasks = {}
    adapter._lifecycle_tasks = set()
    adapter._disconnecting = False
    adapter.run_start_timeout_seconds = 3
    adapter.stop_confirm_timeout_seconds = 1
    return adapter


def valid_gateway_config(**overrides):
    extra = {
        "router_url": "wss://router.example",
        "hermes_agent_id": "agent_contract123",
        "gateway_id": "gw_contract123",
        "gateway_token": "x" * 64,
        "api_server_key": "y" * 64,
        "local_api_url": "http://127.0.0.1:8642",
    }
    extra.update(overrides)
    return SimpleNamespace(enabled=True, extra=extra)


class FakeSocket:
    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []
        self.closed = False
        self._receive_forever = asyncio.Event()

    async def receive(self):
        if self.frames:
            payload = self.frames.pop(0)
            return SimpleNamespace(
                type=adapter_module.aiohttp.WSMsgType.TEXT,
                data=json.dumps(payload),
            )
        await self._receive_forever.wait()

    async def send_str(self, payload):
        self.sent.append(json.loads(payload))

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        await self._receive_forever.wait()
        raise StopAsyncIteration


class FakeClientSession:
    def __init__(self, socket):
        self.socket = socket
        self.closed = False

    async def ws_connect(self, *_args, **_kwargs):
        return self.socket

    async def close(self):
        self.closed = True


class FakeSseContent:
    def __init__(self, lines):
        self.lines = list(lines)

    async def readline(self):
        return self.lines.pop(0) if self.lines else b""


class FakeSseResponse:
    def __init__(self, lines, status=200):
        self.status = status
        self.content = FakeSseContent(lines)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class FakeStreamSession:
    def __init__(self, lines):
        self.closed = False
        self.lines = lines

    def get(self, *_args, **_kwargs):
        return FakeSseResponse(self.lines)


class AdapterContractTests(unittest.IsolatedAsyncioTestCase):
    def test_stream_url_requires_encrypted_remote_transport(self):
        self.assertEqual(
            adapter_module._gateway_stream_url("https://router.example", "gw_contract123"),
            "wss://router.example/router/hermes-hub-gateways/gw_contract123/stream",
        )
        with self.assertRaises(ValueError):
            adapter_module._gateway_stream_url("http://192.0.2.10:4320", "gw_contract123")
        self.assertEqual(
            adapter_module._gateway_stream_url("http://127.0.0.1:4320", "gw_contract123"),
            "ws://127.0.0.1:4320/router/hermes-hub-gateways/gw_contract123/stream",
        )

    def test_required_runtime_identity_has_two_public_ids(self):
        values = {
            "HERMES_HUB_ROUTER_URL": "https://router.example",
            "HERMES_HUB_AGENT_ID": "agent_contract123",
            "HERMES_HUB_GATEWAY_ID": "gw_contract123",
            "HERMES_HUB_GATEWAY_TOKEN": "x" * 64,
            "API_SERVER_KEY": "y" * 64,
        }
        with patch.dict(os.environ, values, clear=True):
            self.assertEqual(
                adapter_module._required_values(),
                tuple(values[key] for key in values),
            )

    def test_requirements_check_is_dependency_only(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(adapter_module.check_requirements())

    def test_config_only_values_are_valid_after_global_api_server_enablement(self):
        config = valid_gateway_config()
        with patch.dict(os.environ, {"API_SERVER_ENABLED": "true"}, clear=True):
            self.assertTrue(adapter_module.validate_config(config))
            self.assertTrue(adapter_module.is_configured(config))
            self.assertTrue(adapter_module.is_connected(config))
            adapter = adapter_module.HermesHubGatewayAdapter(config)

        self.assertEqual(adapter.router_url, config.extra["router_url"])
        self.assertEqual(adapter.hermes_agent_id, config.extra["hermes_agent_id"])
        self.assertEqual(adapter.gateway_id, config.extra["gateway_id"])

    def test_config_requires_api_server_enablement(self):
        config = valid_gateway_config()
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(adapter_module.validate_config(config))
            self.assertEqual(
                adapter_module._config_validation_error(config)[0],
                "api_server_disabled",
            )

    def test_router_transport_rejects_plaintext_outside_loopback(self):
        valid_urls = (
            "https://router.example",
            "wss://router.example",
            "http://127.0.0.1:4320",
            "ws://localhost:4320",
        )
        with patch.dict(os.environ, {"API_SERVER_ENABLED": "true"}, clear=True):
            for router_url in valid_urls:
                with self.subTest(router_url=router_url):
                    self.assertTrue(
                        adapter_module.validate_config(
                            valid_gateway_config(router_url=router_url)
                        )
                    )
            for router_url in ("http://router.example", "ws://router.example"):
                with self.subTest(router_url=router_url):
                    self.assertFalse(
                        adapter_module.validate_config(
                            valid_gateway_config(router_url=router_url)
                        )
                    )

    def test_local_api_accepts_http_or_https_only_on_loopback(self):
        valid_urls = (
            "http://127.0.0.1:8642",
            "https://localhost:8642",
            "https://[::1]:8642/",
        )
        invalid_urls = (
            "https://api.example:8642",
            "http://192.0.2.10:8642",
            "ftp://localhost:8642",
            "http://localhost:8642/v1",
        )
        with patch.dict(os.environ, {"API_SERVER_ENABLED": "true"}, clear=True):
            for local_api_url in valid_urls:
                with self.subTest(local_api_url=local_api_url):
                    self.assertTrue(
                        adapter_module.validate_config(
                            valid_gateway_config(local_api_url=local_api_url)
                        )
                    )
            for local_api_url in invalid_urls:
                with self.subTest(local_api_url=local_api_url):
                    self.assertFalse(
                        adapter_module.validate_config(
                            valid_gateway_config(local_api_url=local_api_url)
                        )
                    )

    def test_config_rejects_invalid_identity_and_timeout_ranges(self):
        invalid_overrides = (
            {"hermes_agent_id": "host_contract123"},
            {"gateway_id": "gateway_contract123"},
            {"max_concurrency": 0},
            {"max_concurrency": 65},
            {"request_timeout_seconds": 2},
            {"request_timeout_seconds": 601},
            {"handshake_timeout_seconds": 0},
            {"handshake_timeout_seconds": 31},
            {"run_start_timeout_seconds": 2},
            {"run_start_timeout_seconds": 31},
            {"stop_confirm_timeout_seconds": 0},
            {"stop_confirm_timeout_seconds": 31},
            {"request_timeout_seconds": "not-a-number"},
        )
        with patch.dict(os.environ, {"API_SERVER_ENABLED": "true"}, clear=True):
            for overrides in invalid_overrides:
                with self.subTest(overrides=overrides):
                    self.assertFalse(
                        adapter_module.validate_config(valid_gateway_config(**overrides))
                    )

    async def test_connect_marks_connected_only_after_ready_and_matching_hello_ack(self):
        values = {
            "HERMES_HUB_ROUTER_URL": "https://router.example",
            "HERMES_HUB_AGENT_ID": "agent_contract123",
            "HERMES_HUB_GATEWAY_ID": "gw_contract123",
            "HERMES_HUB_GATEWAY_TOKEN": "x" * 64,
            "API_SERVER_KEY": "y" * 64,
            "API_SERVER_ENABLED": "true",
        }
        control = {
            "hermesAgentId": values["HERMES_HUB_AGENT_ID"],
            "gatewayId": values["HERMES_HUB_GATEWAY_ID"],
            "protocol": protocol_module.PROTOCOL,
            "protocols": [protocol_module.PROTOCOL],
        }
        socket = FakeSocket(
            [
                {"type": "ready", **control},
                {"type": "hello_ack", **control},
            ]
        )
        session = FakeClientSession(socket)
        with (
            patch.dict(os.environ, values, clear=True),
            patch.object(adapter_module.aiohttp, "ClientSession", return_value=session),
        ):
            adapter = adapter_module.HermesHubGatewayAdapter(SimpleNamespace(extra={}))
            adapter._discover_capabilities = AsyncMock(return_value=("health",))
            self.assertTrue(await adapter.connect())

        self.assertTrue(adapter._running)
        self.assertEqual(adapter.lock_scope, "hermes-hub-agent-id")
        self.assertEqual(adapter.lock_identity, values["HERMES_HUB_AGENT_ID"])
        self.assertEqual([frame["type"] for frame in socket.sent], ["hello"])
        await adapter.disconnect()

    async def test_connect_rejects_mismatched_hello_ack(self):
        values = {
            "HERMES_HUB_ROUTER_URL": "https://router.example",
            "HERMES_HUB_AGENT_ID": "agent_contract123",
            "HERMES_HUB_GATEWAY_ID": "gw_contract123",
            "HERMES_HUB_GATEWAY_TOKEN": "x" * 64,
            "API_SERVER_KEY": "y" * 64,
            "API_SERVER_ENABLED": "true",
        }
        control = {
            "hermesAgentId": values["HERMES_HUB_AGENT_ID"],
            "gatewayId": values["HERMES_HUB_GATEWAY_ID"],
            "protocol": protocol_module.PROTOCOL,
            "protocols": [protocol_module.PROTOCOL],
        }
        socket = FakeSocket(
            [
                {"type": "ready", **control},
                {"type": "hello_ack", **control, "gatewayId": "gw_other123"},
            ]
        )
        session = FakeClientSession(socket)
        with (
            patch.dict(os.environ, values, clear=True),
            patch.object(adapter_module.aiohttp, "ClientSession", return_value=session),
        ):
            adapter = adapter_module.HermesHubGatewayAdapter(SimpleNamespace(extra={}))
            adapter._discover_capabilities = AsyncMock(return_value=("health",))
            self.assertFalse(await adapter.connect())

        self.assertFalse(adapter._running)
        self.assertEqual(adapter.fatal_error_code, "router_handshake_identity_mismatch")
        self.assertTrue(socket.closed)

    async def test_connect_fails_on_bounded_hello_ack_timeout(self):
        values = {
            "HERMES_HUB_ROUTER_URL": "https://router.example",
            "HERMES_HUB_AGENT_ID": "agent_contract123",
            "HERMES_HUB_GATEWAY_ID": "gw_contract123",
            "HERMES_HUB_GATEWAY_TOKEN": "x" * 64,
            "API_SERVER_KEY": "y" * 64,
            "API_SERVER_ENABLED": "true",
        }
        socket = FakeSocket(
            [
                {
                    "type": "ready",
                    "hermesAgentId": values["HERMES_HUB_AGENT_ID"],
                    "gatewayId": values["HERMES_HUB_GATEWAY_ID"],
                    "protocol": protocol_module.PROTOCOL,
                    "protocols": [protocol_module.PROTOCOL],
                }
            ]
        )
        session = FakeClientSession(socket)
        with (
            patch.dict(os.environ, values, clear=True),
            patch.object(adapter_module.aiohttp, "ClientSession", return_value=session),
        ):
            adapter = adapter_module.HermesHubGatewayAdapter(SimpleNamespace(extra={}))
            adapter.handshake_timeout_seconds = 0.01
            adapter._discover_capabilities = AsyncMock(return_value=("health",))
            self.assertFalse(await adapter.connect())

        self.assertEqual(adapter.fatal_error_code, "router_handshake_timeout")
        self.assertTrue(socket.closed)

    async def test_send_json_enforces_the_same_wire_frame_bound(self):
        adapter = object.__new__(adapter_module.HermesHubGatewayAdapter)
        adapter._socket = FakeSocket([])
        adapter._send_lock = asyncio.Lock()
        with patch.object(adapter_module, "MAX_WIRE_FRAME_BYTES", 16):
            with self.assertRaises(protocol_module.ProtocolError) as raised:
                await adapter._send_json({"type": "frame", "data": "x" * 32})
        self.assertEqual(raised.exception.code, "wire_frame_too_large")
        self.assertEqual(adapter._socket.sent, [])

    async def test_same_session_cannot_start_a_second_run(self):
        adapter = runtime_adapter()
        adapter.capabilities = ("chat.stream",)
        adapter._active_session_ids = {"session_1"}
        adapter._ensure_session = AsyncMock(return_value="session_1")
        adapter._stream_session = AsyncMock()
        body = base64.b64encode(json.dumps({"input": "hello", "session_id": "session_1"}).encode()).decode()

        with self.assertRaises(protocol_module.ProtocolError) as raised:
            await adapter._handle_stream_request(
                {"id": "request_1", "path": "/api/chat-run/runs", "bodyBase64": body}
            )
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.code, "session_busy")
        adapter._stream_session.assert_not_awaited()

    async def test_cancel_delegates_stop_to_stream_unwind_once(self):
        adapter = object.__new__(adapter_module.HermesHubGatewayAdapter)
        task = Mock()
        task.done.return_value = False
        adapter._request_tasks = {"request_1": task}
        adapter._stop_stream_run = AsyncMock()

        await adapter._cancel_request("request_1")

        task.cancel.assert_called_once_with()
        adapter._stop_stream_run.assert_not_awaited()

    async def test_stream_transport_failure_stops_started_run_once(self):
        adapter = runtime_adapter()
        adapter._api_request = AsyncMock(
            side_effect=[
                (200, {}, b'{"data":[]}'),
                (202, {}, b'{"run_id":"run_1"}'),
            ]
        )
        adapter._send_stream_chunk = AsyncMock(side_effect=RuntimeError("closed"))
        adapter._stop_run = AsyncMock(return_value={"run_id": "run_1", "status": "cancelled"})

        with self.assertRaises(RuntimeError):
            await adapter._stream_session(
                {"id": "request_1"},
                {"input": "hello"},
                "hello",
                "session_1",
            )

        adapter._stop_run.assert_awaited_once_with("session_1", "run_1")
        self.assertEqual(adapter._stream_runs, {})

    async def test_cancel_during_start_collects_run_id_and_compensates_stop(self):
        adapter = runtime_adapter()
        accepted = asyncio.Event()

        async def api_request(method, path, **_kwargs):
            self.assertEqual((method, path), ("POST", "/v1/runs"))
            await accepted.wait()
            return 202, {}, b'{"run_id":"run_cancelled_start"}'

        async def stop_run(session_id, run_id):
            adapter._release_session_run(session_id, run_id)
            return {"run_id": run_id, "status": "cancelled"}

        adapter._api_request = api_request
        adapter._stop_run = AsyncMock(side_effect=stop_run)
        task = asyncio.create_task(
            adapter._start_run("request_1", "session_1", {"input": "hidden"})
        )
        await asyncio.sleep(0)
        task.cancel()
        accepted.set()
        with self.assertRaises(asyncio.CancelledError):
            await task

        adapter._stop_run.assert_awaited_once_with("session_1", "run_cancelled_start")
        self.assertNotIn("session_1", adapter._active_session_ids)
        self.assertNotIn("session_1", adapter._session_runs)
        self.assertEqual(adapter._pending_run_starts, {})

    async def test_unconfirmed_stop_keeps_session_busy_and_schedules_reconcile(self):
        adapter = runtime_adapter()
        adapter.stop_confirm_timeout_seconds = 0
        adapter._api_request = AsyncMock(
            side_effect=[
                (202, {}, b'{"run_id":"run_1","status":"stopping"}'),
                (200, {}, b'{"run_id":"run_1","status":"running"}'),
            ]
        )
        adapter._start_reconcile = Mock()
        adapter._register_run("request_1", "session_1", "run_1")

        self.assertIsNone(await adapter._stop_run("session_1", "run_1"))
        self.assertEqual(adapter._quarantined_sessions["session_1"], "run_1")
        self.assertIn("session_1", adapter._active_session_ids)
        adapter._start_reconcile.assert_called_once_with("session_1", "run_1")

        adapter.capabilities = ("chat.stream",)
        adapter._ensure_session = AsyncMock(return_value="session_1")
        adapter._stream_session = AsyncMock()
        body = base64.b64encode(
            json.dumps({"input": "hidden", "session_id": "session_1"}).encode()
        ).decode()
        with self.assertRaises(protocol_module.ProtocolError) as raised:
            await adapter._handle_stream_request(
                {"id": "request_2", "path": "/api/chat-run/runs", "bodyBase64": body}
            )
        self.assertEqual(raised.exception.code, "session_busy")

    async def test_reconcile_releases_session_only_after_terminal_status(self):
        adapter = runtime_adapter()
        adapter._register_run("request_1", "session_1", "run_1")
        adapter._quarantine_session("session_1", "run_1")
        adapter._poll_run_until_terminal = AsyncMock(
            side_effect=[None, {"run_id": "run_1", "status": "cancelled"}]
        )
        with patch.object(adapter_module.asyncio, "sleep", new=AsyncMock()):
            await adapter._reconcile_until_terminal("session_1", "run_1")

        self.assertNotIn("session_1", adapter._active_session_ids)
        self.assertNotIn("session_1", adapter._quarantined_sessions)
        self.assertNotIn("session_1", adapter._session_runs)

    async def test_terminal_event_is_unique_and_later_upstream_frames_are_ignored(self):
        adapter = runtime_adapter()
        adapter.api_url = "http://127.0.0.1:8642"
        adapter.api_key = "not-logged"
        adapter._session = FakeStreamSession(
            [
                b'event: message.delta\n',
                b'data: {"delta":"ok"}\n',
                b'\n',
                b'event: run.completed\n',
                b'data: {"event":"run.completed","output":"ok"}\n',
                b'\n',
                b'event: tool.started\n',
                b'data: {"event":"tool.started","tool":"late"}\n',
                b'\n',
            ]
        )
        adapter._api_request = AsyncMock(
            side_effect=[
                (200, {}, b'{"data":[]}'),
                (202, {}, b'{"run_id":"run_1"}'),
            ]
        )
        adapter._send_json = AsyncMock(return_value=True)

        await adapter._stream_session(
            {"id": "request_1"},
            {"input": "hidden"},
            "hidden",
            "session_1",
        )

        frames = [call.args[0] for call in adapter._send_json.await_args_list]
        chunk_events = [frame["event"] for frame in frames if frame["type"] == "rpc_stream_chunk"]
        self.assertEqual(
            chunk_events,
            ["run.started", "message.delta", "message.complete", "run.completed"],
        )
        self.assertEqual(sum(event.startswith("run.") and event != "run.started" for event in chunk_events), 1)
        self.assertEqual(frames[-1]["type"], "rpc_stream_end")

    async def test_poll_fallback_emits_the_same_terminal_event_semantics(self):
        adapter = runtime_adapter()
        adapter.api_url = "http://127.0.0.1:8642"
        adapter.api_key = "not-logged"
        adapter._session = FakeStreamSession([])
        adapter._api_request = AsyncMock(
            side_effect=[
                (200, {}, b'{"data":[]}'),
                (202, {}, b'{"run_id":"run_1"}'),
            ]
        )
        adapter._poll_run_until_terminal = AsyncMock(
            return_value={"run_id": "run_1", "status": "completed", "output": "done"}
        )
        adapter._send_json = AsyncMock(return_value=True)

        await adapter._stream_session(
            {"id": "request_1"},
            {"input": "hidden"},
            "hidden",
            "session_1",
        )

        frames = [call.args[0] for call in adapter._send_json.await_args_list]
        chunk_events = [frame["event"] for frame in frames if frame["type"] == "rpc_stream_chunk"]
        self.assertEqual(chunk_events, ["run.started", "message.complete", "run.completed"])
        terminal = next(frame for frame in frames if frame.get("event") == "run.completed")
        self.assertEqual(terminal["data"]["status"], "completed")

    async def test_stream_output_limit_stops_the_accepted_run(self):
        adapter = runtime_adapter()
        adapter.api_url = "http://127.0.0.1:8642"
        adapter.api_key = "not-logged"
        adapter._session = FakeStreamSession(
            [
                b'event: message.delta\n',
                b'data: {"delta":"too large"}\n',
                b'\n',
            ]
        )
        adapter._api_request = AsyncMock(
            side_effect=[
                (200, {}, b'{"data":[]}'),
                (202, {}, b'{"run_id":"run_1"}'),
            ]
        )
        adapter._send_json = AsyncMock(return_value=True)
        adapter._stop_run = AsyncMock(return_value={"run_id": "run_1", "status": "cancelled"})

        with patch.object(adapter_module, "MAX_STREAM_OUTPUT_BYTES", 4):
            with self.assertRaises(protocol_module.ProtocolError) as raised:
                await adapter._stream_session(
                    {"id": "request_1"},
                    {"input": "hidden"},
                    "hidden",
                    "session_1",
                )

        self.assertEqual(raised.exception.code, "output_too_large")
        adapter._stop_run.assert_awaited_once_with("session_1", "run_1")


if __name__ == "__main__":
    unittest.main()
