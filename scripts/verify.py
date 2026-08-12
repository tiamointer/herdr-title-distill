#!/usr/bin/env python3
"""Verify deterministic title compression, safe installation, and optional live Herdr behavior."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
EXTENSION = SKILL_ROOT / "extension" / "index.ts"
INSTALLER = SKILL_ROOT / "scripts" / "install.py"
RUNTIME_CHECK = SKILL_ROOT / "tests" / "runtime_check.ts"
LIVE_SYNC = SKILL_ROOT / "scripts" / "live_sync.ts"
TARGET_NAME = "omp-herdr-title-sync.ts"
MODEL_EXECUTABLES = {"claude", "codex"}


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float = 30,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd or SKILL_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def parse_json_output(completed: subprocess.CompletedProcess[str], context: str) -> dict[str, Any]:
    require(
        completed.returncode == 0,
        f"{context} failed ({completed.returncode}): {completed.stderr or completed.stdout}",
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{context} returned invalid JSON: {completed.stdout}") from exc
    require(isinstance(payload, dict), f"{context} did not return an object")
    return payload

def read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def herdr_json(*args: str, timeout: float = 10) -> dict[str, Any]:
    return parse_json_output(run(["herdr", *args], timeout=timeout), f"herdr {' '.join(args)}")


def nested_record(payload: dict[str, Any], *keys: str) -> dict[str, Any]:
    current: Any = payload
    for key in keys:
        require(isinstance(current, dict), f"missing object before {key}")
        current = current.get(key)
    require(isinstance(current, dict), f"missing object at {'.'.join(keys)}")
    return current


def herdr_command(*args: str, timeout: float = 10) -> None:
    completed = run(["herdr", *args], timeout=timeout)
    require(
        completed.returncode == 0,
        f"herdr {' '.join(args)} failed ({completed.returncode}): "
        f"{completed.stderr or completed.stdout}",
    )


def model_processes() -> dict[int, str]:
    completed = run(["ps", "-axo", "pid=,comm="], cwd=Path("/tmp"), timeout=15)
    require(completed.returncode == 0, completed.stderr)
    found: dict[int, str] = {}
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        executable = Path(fields[1]).name
        if executable in MODEL_EXECUTABLES:
            found[int(fields[0])] = executable
    return found


def verify_runtime_source() -> dict[str, Any]:
    source = EXTENSION.read_text(encoding="utf-8")
    forbidden = [
        "node:child_process",
        "Bun.spawn",
        "fetch(",
        '"claude"',
        '"codex"',
        "http://",
        "https://",
        "@ts-nocheck",
    ]
    hits = [token for token in forbidden if token in source]
    require(not hits, f"runtime source contains forbidden model/network paths: {hits}")
    return {
        "forbidden_runtime_paths": hits,
        "runtime_imports": ["node:fs", "node:net", "node:path", "node:url"],
    }


def verify_installer_lifecycle(temp_root: Path) -> dict[str, Any]:
    agent_dir = temp_root / "agent"
    extensions_dir = agent_dir / "extensions"
    extensions_dir.mkdir(parents=True)
    keep = extensions_dir / "keep.ts"
    keep.write_text("export default () => {};\n", encoding="utf-8")
    state_dir = temp_root / "state"
    command = [
        sys.executable,
        str(INSTALLER),
        "--agent-dir",
        str(agent_dir),
        "--state-dir",
        str(state_dir),
    ]

    first = parse_json_output(run(command), "first install")
    target = extensions_dir / TARGET_NAME
    require(first.get("status") == "installed", str(first))
    require(target.is_symlink(), "installer did not create a symlink")
    require(target.resolve() == EXTENSION.resolve(), "symlink points to the wrong extension")

    second = parse_json_output(run(command), "second install")
    require(second.get("status") == "already-installed", str(second))

    removed = parse_json_output(run([*command, "--uninstall", "--skip-restore"]), "uninstall")
    require(removed.get("status") == "uninstalled", str(removed))
    require(not target.exists() and not target.is_symlink(), "uninstall left the extension link")
    require(keep.read_text(encoding="utf-8") == "export default () => {};\n", "unrelated extension changed")

    target.write_text("user-owned\n", encoding="utf-8")
    collision = run(command)
    require(collision.returncode == 2, "collision should fail with exit code 2")
    require(target.read_text(encoding="utf-8") == "user-owned\n", "collision target was overwritten")
    target.unlink()

    return {
        "first_install": first.get("status"),
        "repeat_install": second.get("status"),
        "uninstall": removed.get("status"),
        "unrelated_extension_preserved": True,
        "collision_preserved": True,
    }


def verify_isolated() -> dict[str, Any]:
    require(shutil.which("bun") is not None, "bun is required by OMP and was not found")
    runtime = parse_json_output(run(["bun", str(RUNTIME_CHECK)]), "runtime checks")
    aliases = json.loads((SKILL_ROOT / "config" / "aliases.json").read_text(encoding="utf-8"))
    require(isinstance(aliases, dict) and isinstance(aliases.get("aliases"), dict), "invalid aliases.json")
    with tempfile.TemporaryDirectory(prefix="omp-herdr-title-sync-verify-") as temporary:
        installer = verify_installer_lifecycle(Path(temporary))
    return {
        "status": "pass",
        "runtime": runtime,
        "source_audit": verify_runtime_source(),
        "installer": installer,
        "aliases": "valid",
    }


def create_test_tab(workspace_id: str, cwd: Path) -> tuple[str, str]:
    created = herdr_json(
        "tab",
        "create",
        "--workspace",
        workspace_id,
        "--cwd",
        str(cwd),
        "--no-focus",
    )
    tab = nested_record(created, "result", "tab")
    pane = nested_record(created, "result", "root_pane")
    tab_id = tab.get("tab_id")
    pane_id = pane.get("pane_id")
    require(isinstance(tab_id, str) and isinstance(pane_id, str), "tab create omitted ids")
    return tab_id, pane_id


def live_sync(pane_id: str, title: str, state_dir: Path) -> dict[str, Any]:
    return parse_json_output(
        run(
            [
                "bun",
                str(LIVE_SYNC),
                "--pane",
                pane_id,
                "--title",
                title,
                "--state-dir",
                str(state_dir),
            ],
            timeout=10,
        ),
        f"live sync: {title}",
    )


def pane_info(pane_id: str) -> dict[str, Any]:
    return nested_record(herdr_json("pane", "get", pane_id), "result", "pane")


def tab_info(tab_id: str) -> dict[str, Any]:
    return nested_record(herdr_json("tab", "get", tab_id), "result", "tab")


def run_new_omp_session(
    workspace_id: str,
    temp_root: Path,
    installed_extension: Path,
    baseline_models: dict[int, str],
) -> dict[str, Any]:
    tab_id, pane_id = create_test_tab(workspace_id, temp_root)
    setter = SKILL_ROOT / "tests" / "session_title_probe.ts"
    probe_path = temp_root / "title-probe.json"
    session_dir = temp_root / "sessions"
    state_dir = temp_root / "omp-state"
    session_dir.mkdir()
    long_title = "实现一个无模型的 OMP 到 Herdr 自动标题同步器"
    expected = "OMP无模型标题同步"
    command_parts = [
        "env",
        f"OMP_TITLE_SYNC_TEST_TITLE={shlex.quote(long_title)}",
        f"OMP_TITLE_SYNC_PROBE_PATH={shlex.quote(str(probe_path))}",
        f"OMP_HERDR_TITLE_SYNC_STATE_DIR={shlex.quote(str(state_dir))}",
        "OMP_HERDR_TITLE_SYNC_INTERVAL_MS=250",
        "omp",
        "--no-extensions",
        "-e",
        shlex.quote(str(installed_extension)),
        "-e",
        shlex.quote(str(setter)),
        "--no-skills",
        "--no-rules",
        "--no-tools",
        "--no-title",
        "--session-dir",
        shlex.quote(str(session_dir)),
        "--cwd",
        "/tmp",
    ]
    observed_models = dict(baseline_models)
    try:
        herdr_command("pane", "run", pane_id, " ".join(command_parts))
        deadline = time.monotonic() + 20
        observed_label: str | None = None
        observed_tab_label: str | None = None
        while time.monotonic() < deadline:
            observed_models.update(model_processes())
            current = pane_info(pane_id)
            current_tab = tab_info(tab_id)
            label = current.get("label")
            tab_label = current_tab.get("label")
            if isinstance(label, str) and label == expected:
                observed_label = label
            if isinstance(tab_label, str) and tab_label == expected:
                observed_tab_label = tab_label
            if observed_label == expected and observed_tab_label == expected:
                break
            time.sleep(0.2)
        require(observed_label == expected, f"new OMP session did not sync: {observed_label}")
        require(observed_tab_label == expected, "new OMP session did not sync its single-pane tab")

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            observed_models.update(model_processes())
            if probe_path.is_file():
                probe = read_json(probe_path)
                if (
                    probe is not None
                    and probe.get("target") == long_title
                    and probe.get("actual") == long_title
                    and probe.get("hasUI") is True
                ):
                    break
            time.sleep(0.2)
        else:
            raise AssertionError("new OMP session did not observe its title change")

        spawned = {
            pid: name for pid, name in observed_models.items() if pid not in baseline_models
        }
        require(not spawned, f"model CLI processes spawned: {spawned}")
        return {
            "title_change_observed": True,
            "pane_label": observed_label,
            "tab_label": observed_tab_label,
            "visible_chars": len(expected),
            "model_processes_spawned": 0,
        }
    finally:
        herdr_json("tab", "close", tab_id)


def verify_live() -> dict[str, Any]:
    require(os.environ.get("HERDR_ENV") == "1", "live verification must run inside Herdr")
    require(os.environ.get("HERDR_SOCKET_PATH"), "HERDR_SOCKET_PATH is missing")
    require(shutil.which("herdr") is not None, "herdr is not on PATH")
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    require(isinstance(workspace_id, str) and workspace_id, "HERDR_WORKSPACE_ID is missing")

    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent")
    installed_extension = agent_dir / "extensions" / TARGET_NAME
    require(installed_extension.is_symlink(), "runtime extension is not installed")
    require(installed_extension.resolve() == EXTENSION.resolve(), "installed extension points elsewhere")

    baseline_models = model_processes()
    created_tabs: list[str] = []
    with tempfile.TemporaryDirectory(prefix="omp-herdr-title-sync-live-") as temporary:
        temp_root = Path(temporary)
        state_dir = temp_root / "direct-state"
        tab_id, pane_id = create_test_tab(workspace_id, temp_root)
        created_tabs.append(tab_id)
        try:
            first = live_sync(pane_id, "Evaluate Herdr auto-title skill", state_dir)
            require(first.get("title") == "Herdr标题", str(first))
            require(pane_info(pane_id).get("label") == "Herdr标题", "pane label did not sync")
            require(tab_info(tab_id).get("label") == "Herdr标题", "single-pane tab did not sync")

            split = herdr_json("pane", "split", pane_id, "--direction", "right", "--no-focus")
            second_pane = nested_record(split, "result", "pane").get("pane_id")
            require(isinstance(second_pane, str), "pane split omitted pane id")
            multi = live_sync(pane_id, "设计提示词并生成音乐", state_dir)
            require(multi.get("tab_status") == "multi-pane-preserved", str(multi))
            require(tab_info(tab_id).get("label") == "Herdr标题", "multi-pane tab changed")

            herdr_json("pane", "rename", pane_id, "手工窗")
            protected_pane = live_sync(pane_id, "Remove OpenClaw and clean residue", state_dir)
            require(protected_pane.get("pane_status") == "manual-protected", str(protected_pane))
            require(pane_info(pane_id).get("label") == "手工窗", "manual pane label was overwritten")

            herdr_json("pane", "close", second_pane)
            herdr_json("tab", "rename", tab_id, "手工页")
            herdr_json("pane", "rename", pane_id, "--clear")
            protected_tab = live_sync(pane_id, "Create vertical abstract memory panel", state_dir)
            require(protected_tab.get("tab_status") == "manual-protected", str(protected_tab))
            require(pane_info(pane_id).get("label") == "记忆面板", "cleared pane did not resume auto naming")
            require(tab_info(tab_id).get("label") == "手工页", "manual tab label was overwritten")
        finally:
            herdr_json("tab", "close", tab_id)
            created_tabs.remove(tab_id)

        omp_session = run_new_omp_session(
            workspace_id,
            temp_root,
            installed_extension,
            baseline_models,
        )

    require(not created_tabs, f"temporary tabs remain: {created_tabs}")
    return {
        "status": "pass",
        "single_pane_tab_synced": True,
        "multi_pane_tab_preserved": True,
        "manual_pane_protected": True,
        "manual_tab_protected": True,
        "temporary_labels_restored": True,
        "new_omp_session": omp_session,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="also exercise real Herdr panes and a no-model OMP session")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report: dict[str, Any] = {"isolated": verify_isolated()}
        if args.live:
            report["live"] = verify_live()
        report["status"] = "pass"
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {"status": "fail", "error": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
