import base64
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from protocol import (  # noqa: E402
    PROTOCOL,
    ProtocolError,
    SseParser,
    approval_choice,
    capabilities_from_probe,
    conversation_history,
    decode_body_base64,
    gateway_hello,
    is_allowed_api_path,
    model_options_payload,
    normalized_path,
    required_capability_for_api_path,
    safe_error,
    validate_router_handshake,
)
import protocol as protocol_module  # noqa: E402


def api_capability_payload():
    return {
        "object": "hermes.api_server.capabilities",
        "features": {
            "session_resources": True,
            "session_fork": True,
            "run_submission": True,
            "run_status": True,
            "run_events_sse": True,
            "run_stop": True,
            "run_approval_response": True,
            "approval_events": True,
            "tool_progress_events": True,
        },
        "endpoints": {
            "health": {"method": "GET", "path": "/health"},
            "models": {"method": "GET", "path": "/v1/models"},
            "sessions": {"method": "GET", "path": "/api/sessions"},
            "session_create": {"method": "POST", "path": "/api/sessions"},
            "session": {"method": "GET", "path": "/api/sessions/{session_id}"},
            "session_update": {"method": "PATCH", "path": "/api/sessions/{session_id}"},
            "session_delete": {"method": "DELETE", "path": "/api/sessions/{session_id}"},
            "session_messages": {"method": "GET", "path": "/api/sessions/{session_id}/messages"},
            "session_fork": {"method": "POST", "path": "/api/sessions/{session_id}/fork"},
            "runs": {"method": "POST", "path": "/v1/runs"},
            "run_status": {"method": "GET", "path": "/v1/runs/{run_id}"},
            "run_events": {"method": "GET", "path": "/v1/runs/{run_id}/events"},
            "run_stop": {"method": "POST", "path": "/v1/runs/{run_id}/stop"},
            "run_approval": {"method": "POST", "path": "/v1/runs/{run_id}/approval"},
        },
    }


def enable_public_cron_contract(payload):
    payload["features"]["jobs_admin"] = True
    payload["endpoints"].update({
        "jobs": {"method": "GET", "path": "/api/jobs"},
        "job_create": {"method": "POST", "path": "/api/jobs"},
        "job": {"method": "GET", "path": "/api/jobs/{job_id}"},
        "job_update": {"method": "PATCH", "path": "/api/jobs/{job_id}"},
        "job_delete": {"method": "DELETE", "path": "/api/jobs/{job_id}"},
        "job_pause": {"method": "POST", "path": "/api/jobs/{job_id}/pause"},
        "job_resume": {"method": "POST", "path": "/api/jobs/{job_id}/resume"},
        "job_run": {"method": "POST", "path": "/api/jobs/{job_id}/run"},
    })
    return payload


class ProtocolTests(unittest.TestCase):
    def test_hello_carries_stable_agent_and_rotatable_gateway_identity(self):
        hello = gateway_hello(
            "agent_12345678",
            "gw_12345678",
            ("cron", "health", "session.steer", "models"),
        )
        self.assertEqual(hello["hermesAgentId"], "agent_12345678")
        self.assertEqual(hello["gatewayId"], "gw_12345678")
        self.assertEqual(hello["capabilities"], ["health", "models", "cron"])
        self.assertNotIn("gatewayToken", hello)
        with self.assertRaises(ProtocolError):
            gateway_hello("invalid", "gw_12345678", ())

    def test_capabilities_are_derived_from_live_contract(self):
        capabilities = capabilities_from_probe(api_capability_payload())
        self.assertEqual(
            capabilities,
            (
                "health",
                "sessions",
                "sessions.usage",
                "chat.stream",
                "chat.message.delta",
                "chat.reasoning",
                "chat.tools",
                "run.stop",
                "run.approval",
            ),
        )
        for unsupported in ("session.steer", "clarify.respond", "media", "kanban"):
            self.assertNotIn(unsupported, capabilities)

    def test_model_probe_is_truthful_and_cron_requires_the_full_public_contract(self):
        payload = api_capability_payload()
        self.assertNotIn("models", capabilities_from_probe(payload))
        self.assertNotIn("cron", capabilities_from_probe(payload))
        capabilities = capabilities_from_probe(payload, models_available=True)
        self.assertIn("models", capabilities)
        self.assertNotIn("cron", capabilities)

        payload = enable_public_cron_contract(api_capability_payload())
        self.assertIn("cron", capabilities_from_probe(payload))
        del payload["endpoints"]["job_run"]
        self.assertNotIn("cron", capabilities_from_probe(payload))

        payload = enable_public_cron_contract(api_capability_payload())
        payload["features"]["jobs_admin"] = False
        self.assertNotIn("cron", capabilities_from_probe(payload))

    def test_chat_stream_requires_safe_stop_contract(self):
        payload = api_capability_payload()
        payload["features"]["run_stop"] = False
        capabilities = capabilities_from_probe(payload)
        self.assertNotIn("chat.stream", capabilities)
        self.assertNotIn("run.stop", capabilities)

    def test_path_allowlist_methods_and_traversal(self):
        self.assertEqual(normalized_path("api/sessions?limit=10"), "/api/sessions?limit=10")
        self.assertTrue(is_allowed_api_path("/api/sessions/s1/messages", "GET"))
        self.assertFalse(is_allowed_api_path("/api/sessions/s1/messages", "POST"))
        self.assertTrue(is_allowed_api_path("/api/sessions/s1/fork", "POST"))
        self.assertFalse(is_allowed_api_path("/api/sessions/s1/fork", "GET"))
        self.assertTrue(is_allowed_api_path("/api/jobs/a1b2c3d4e5f6/run", "POST"))
        self.assertFalse(is_allowed_api_path("/api/jobs/job_1/run", "GET"))
        self.assertFalse(is_allowed_api_path("/api/secrets", "GET"))
        with self.assertRaises(ProtocolError):
            normalized_path("/api/sessions/../secrets")
        with self.assertRaises(ProtocolError):
            normalized_path("/api/sessions#fragment")

    def test_allowlisted_paths_still_require_negotiated_capability(self):
        self.assertEqual(required_capability_for_api_path("/api/sessions"), "sessions")
        self.assertEqual(required_capability_for_api_path("/v1/models"), "models")
        self.assertEqual(required_capability_for_api_path("/api/jobs/a1b2c3d4e5f6"), "cron")
        self.assertIsNone(required_capability_for_api_path("/api/secrets"))

    def test_router_handshake_requires_both_identities_and_protocol(self):
        frame = {
            "type": "hello_ack",
            "hermesAgentId": "agent_12345678",
            "gatewayId": "gw_12345678",
            "protocol": PROTOCOL,
            "protocols": [PROTOCOL],
        }
        self.assertEqual(
            validate_router_handshake(
                frame,
                expected_type="hello_ack",
                hermes_agent_id="agent_12345678",
                gateway_id="gw_12345678",
            )["type"],
            "hello_ack",
        )
        with self.assertRaises(ProtocolError) as mismatch:
            validate_router_handshake(
                {**frame, "gatewayId": "gw_other123"},
                expected_type="hello_ack",
                hermes_agent_id="agent_12345678",
                gateway_id="gw_12345678",
            )
        self.assertEqual(mismatch.exception.code, "router_handshake_identity_mismatch")
        with self.assertRaises(ProtocolError) as protocol_mismatch:
            validate_router_handshake(
                {**frame, "protocol": "other/v1", "protocols": ["other/v1"]},
                expected_type="hello_ack",
                hermes_agent_id="agent_12345678",
                gateway_id="gw_12345678",
            )
        self.assertEqual(protocol_mismatch.exception.code, "router_handshake_protocol_mismatch")

    def test_base64_is_strict(self):
        self.assertEqual(decode_body_base64(base64.b64encode(b"ok").decode()), b"ok")
        with self.assertRaises(ProtocolError):
            decode_body_base64("%%%")

    def test_model_options_are_provider_grouped(self):
        result = model_options_payload({"data": [{"id": "MiniMax-M3", "root": "minimax/m3"}]})
        self.assertEqual(result["providers"][0]["id"], "hermes-hub-gateway")
        self.assertEqual(result["models"][0]["id"], "MiniMax-M3")

    def test_history_keeps_visible_context(self):
        result = conversation_history(
            {"data": [{"role": "user", "content": "hi"}, {"role": "tool", "content": "done"}, {"role": "assistant", "content": "ok"}]}
        )
        self.assertEqual([item["role"] for item in result], ["user", "assistant", "assistant"])

    def test_sse_parser_preserves_event_and_json(self):
        parser = SseParser()
        self.assertIsNone(parser.feed_line(b"event: message.delta\n"))
        self.assertIsNone(parser.feed_line(b'data: {"delta":"a","seq":1}\n'))
        event = parser.feed_line(b"\n")
        self.assertEqual(event.event, "message.delta")
        self.assertEqual(event.data["delta"], "a")

    def test_sse_parser_bounds_the_whole_multiline_event(self):
        parser = SseParser()
        with patch.object(protocol_module, "MAX_EVENT_BYTES", 10):
            self.assertIsNone(parser.feed_line(b"data: 123\n"))
            self.assertIsNone(parser.feed_line(b"data: 456\n"))
            with self.assertRaises(ProtocolError) as raised:
                parser.feed_line(b"data: 789\n")
        self.assertEqual(raised.exception.code, "event_too_large")

    def test_safe_error_redacts_bearer_url_and_query_credentials(self):
        redacted = safe_error(
            "Bearer abc.def https://user:pass@example.test/path?token=secret&ok=1 API_KEY=value"
        )
        for secret in ("abc.def", "user:pass", "token=secret", "API_KEY=value"):
            self.assertNotIn(secret, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_approval_aliases_are_bounded(self):
        self.assertEqual(approval_choice("approve"), "once")
        self.assertEqual(approval_choice("reject"), "deny")
        with self.assertRaises(ProtocolError):
            approval_choice("anything")


if __name__ == "__main__":
    unittest.main()
