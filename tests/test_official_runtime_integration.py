"""Integration smoke against an adjacent official Hermes Agent checkout.

The contract tests use lightweight gateway stubs so they stay fast and
hermetic. This smoke deliberately starts a fresh interpreter with the real
Hermes plugin manager, dynamic Platform enum, registry, and base adapter.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PLUGIN_ROOT.parents[1]
DEFAULT_HERMES_AGENT_ROOT = REPOSITORY_ROOT.parent / "hermes-agent"
PACKAGE_FILES = (
    "__init__.py",
    "adapter.py",
    "protocol.py",
    "plugin.yaml",
)


def _official_agent_root() -> pathlib.Path:
    configured = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    return pathlib.Path(configured).expanduser().resolve() if configured else DEFAULT_HERMES_AGENT_ROOT


def _child_smoke(agent_root: pathlib.Path) -> int:
    sys.path.insert(0, str(agent_root))

    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import platform_registry
    from gateway.platforms.base import BasePlatformAdapter
    from hermes_cli.plugins import discover_plugins

    discover_plugins(force=True)
    entry = platform_registry.get("hermes_hub_gateway")
    if entry is None:
        raise AssertionError("official Hermes plugin discovery did not register hermes_hub_gateway")
    if not entry.check_fn():
        raise AssertionError("dependency-only check_fn rejected the official Hermes runtime")

    # The adapter-specific runtime material is supplied only through the real
    # PlatformConfig.extra object. API_SERVER_ENABLED remains a global Hermes
    # service switch and is intentionally the sole environment setting here.
    os.environ["API_SERVER_ENABLED"] = "true"
    config = PlatformConfig(
        enabled=True,
        extra={
            "router_url": "wss://router.example",
            "hermes_agent_id": "agent_runtime_smoke",
            "gateway_id": "gw_runtime_smoke",
            "gateway_token": "x" * 64,
            "api_server_key": "y" * 64,
            "local_api_url": "https://localhost:8642",
            "max_concurrency": 4,
            "request_timeout_seconds": 30,
            "handshake_timeout_seconds": 10,
            "run_start_timeout_seconds": 15,
            "stop_confirm_timeout_seconds": 8,
        },
    )
    if entry.validate_config is None or not entry.validate_config(config):
        raise AssertionError("official Hermes registry rejected config-only Gateway settings")
    if entry.is_connected is None or not entry.is_connected(config):
        raise AssertionError("official Hermes configured-state probe rejected config-only Gateway settings")

    platform = Platform("hermes_hub_gateway")
    adapter = platform_registry.create_adapter(platform.value, config)
    if not isinstance(adapter, BasePlatformAdapter):
        raise AssertionError("official Hermes registry did not create a BasePlatformAdapter")
    if adapter.platform is not platform:
        raise AssertionError("dynamic Hermes Platform identity is not stable")
    if adapter.router_url != config.extra["router_url"]:
        raise AssertionError("adapter did not consume PlatformConfig.extra")

    print("official-hermes-gateway-runtime-smoke-ok")
    return 0


class OfficialHermesRuntimeIntegrationTests(unittest.TestCase):
    def test_external_plugin_discovery_and_config_only_adapter_creation(self):
        agent_root = _official_agent_root()
        required = (
            agent_root / "gateway" / "config.py",
            agent_root / "gateway" / "platform_registry.py",
            agent_root / "hermes_cli" / "plugins.py",
        )
        if not all(path.is_file() for path in required):
            self.skipTest(f"official Hermes Agent checkout not found at {agent_root}")

        with tempfile.TemporaryDirectory(prefix="hermes-hub-official-runtime-") as temp:
            hermes_home = pathlib.Path(temp) / "hermes-home"
            target = hermes_home / "plugins" / "hermes-hub-gateway"
            target.mkdir(parents=True)
            for name in PACKAGE_FILES:
                shutil.copy2(PLUGIN_ROOT / name, target / name)
            (hermes_home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - hermes-hub-gateway\n",
                encoding="utf-8",
            )

            environment = os.environ.copy()
            for name in tuple(environment):
                if name.startswith("HERMES_HUB_"):
                    environment.pop(name, None)
            for name in (
                "API_SERVER_ENABLED",
                "API_SERVER_KEY",
                "HERMES_ENABLE_PROJECT_PLUGINS",
                "HERMES_SAFE_MODE",
            ):
                environment.pop(name, None)
            environment["HERMES_HOME"] = str(hermes_home)

            result = subprocess.run(
                [sys.executable, "-B", str(pathlib.Path(__file__).resolve()), "--child", str(agent_root)],
                cwd=agent_root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
            self.assertEqual(result.returncode, 0, output)
            self.assertIn("official-hermes-gateway-runtime-smoke-ok", result.stdout)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        raise SystemExit(_child_smoke(pathlib.Path(sys.argv[2]).resolve()))
    unittest.main(verbosity=2)
