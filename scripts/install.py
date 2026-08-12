#!/usr/bin/env python3
"""Install or remove the OMP → Herdr title-sync extension safely."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
SOURCE_EXTENSION = SKILL_ROOT / "extension" / "index.ts"
DEFAULT_AGENT_DIR = Path(
    os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent"
).expanduser()
DEFAULT_STATE_DIR = SKILL_ROOT / "state"
TARGET_NAME = "omp-herdr-title-sync.ts"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def target_is_ours(target: Path) -> bool:
    if not target.is_symlink():
        return False
    try:
        return target.resolve(strict=False) == SOURCE_EXTENSION.resolve(strict=True)
    except OSError:
        return False


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def herdr_json(*args: str) -> dict[str, Any] | None:
    completed = subprocess.run(
        ["herdr", *args],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if completed.returncode != 0:
        return None
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def nested_record(payload: dict[str, Any] | None, *keys: str) -> dict[str, Any] | None:
    current: Any = payload
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, dict) else None


def restore_one_pane(ownership: dict[str, Any], summary: dict[str, Any]) -> None:
    pane_id = ownership.get("pane_id")
    last_auto = ownership.get("last_auto_label")
    if not isinstance(pane_id, str) or not isinstance(last_auto, str):
        return
    pane = nested_record(herdr_json("pane", "get", pane_id), "result", "pane")
    if pane is None:
        summary["stale"] += 1
        return
    if pane.get("label") != last_auto:
        summary["manual_protected"] += 1
        return
    original = ownership.get("original_label")
    args = ["pane", "rename", pane_id]
    if isinstance(original, str) and original:
        args.append(original)
    else:
        args.append("--clear")
    if herdr_json(*args) is None:
        summary["failed"] += 1
        return
    summary["restored"] += 1


def restore_one_tab(tab_id: str, ownership: dict[str, Any], summary: dict[str, Any]) -> None:
    last_auto = ownership.get("last_auto_label")
    original = ownership.get("original_label")
    if not isinstance(last_auto, str) or not isinstance(original, str) or not original:
        return
    tab = nested_record(herdr_json("tab", "get", tab_id), "result", "tab")
    if tab is None:
        summary["stale"] += 1
        return
    if tab.get("label") != last_auto:
        summary["manual_protected"] += 1
        return
    if herdr_json("tab", "rename", tab_id, original) is None:
        summary["failed"] += 1
        return
    summary["restored"] += 1


def restore_owned_labels(state_dir: Path) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "status": "complete",
        "restored": 0,
        "manual_protected": 0,
        "stale": 0,
        "failed": 0,
    }
    if not state_dir.is_dir():
        summary["status"] = "no-state"
        return summary
    if shutil.which("herdr") is None or not os.environ.get("HERDR_SOCKET_PATH"):
        summary["status"] = "herdr-unavailable"
        return summary

    seen_tabs: set[str] = set()
    for state_path in sorted(state_dir.glob("*.json")):
        state = read_json(state_path)
        if state is None:
            summary["failed"] += 1
            continue
        pane = state.get("pane")
        if isinstance(pane, dict):
            restore_one_pane(pane, summary)
        tabs = state.get("tabs")
        if not isinstance(tabs, dict):
            continue
        for tab_id, ownership in tabs.items():
            if tab_id in seen_tabs or not isinstance(ownership, dict):
                continue
            seen_tabs.add(tab_id)
            restore_one_tab(tab_id, ownership, summary)
    if summary["failed"]:
        summary["status"] = "partial"
    return summary


def install(agent_dir: Path) -> int:
    if not SOURCE_EXTENSION.is_file():
        emit({"status": "error", "reason": "source-missing", "source": str(SOURCE_EXTENSION)})
        return 2
    target = agent_dir / "extensions" / TARGET_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        if target_is_ours(target):
            emit({"status": "already-installed", "source": str(SOURCE_EXTENSION), "target": str(target)})
            return 0
        emit({"status": "error", "reason": "target-collision", "target": str(target)})
        return 2
    target.symlink_to(SOURCE_EXTENSION)
    emit({"status": "installed", "source": str(SOURCE_EXTENSION), "target": str(target)})
    return 0


def uninstall(agent_dir: Path, state_dir: Path, restore_labels: bool) -> int:
    target = agent_dir / "extensions" / TARGET_NAME
    restoration = restore_owned_labels(state_dir) if restore_labels else {"status": "skipped"}
    if not target.exists() and not target.is_symlink():
        emit({"status": "already-uninstalled", "target": str(target), "label_restoration": restoration})
        return 0
    if not target_is_ours(target):
        emit({"status": "error", "reason": "target-not-owned", "target": str(target)})
        return 2
    target.unlink()
    emit({"status": "uninstalled", "target": str(target), "label_restoration": restoration})
    return 0


def status(agent_dir: Path) -> int:
    target = agent_dir / "extensions" / TARGET_NAME
    if target_is_ours(target):
        emit({"status": "installed", "source": str(SOURCE_EXTENSION), "target": str(target)})
        return 0
    if target.exists() or target.is_symlink():
        emit({"status": "collision", "target": str(target)})
        return 1
    emit({"status": "not-installed", "target": str(target)})
    return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--uninstall", action="store_true", help="remove only this skill's extension link")
    mode.add_argument("--status", action="store_true", help="show installation status")
    parser.add_argument("--agent-dir", type=Path, default=DEFAULT_AGENT_DIR)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--skip-restore", action="store_true", help="do not restore labels during uninstall")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    agent_dir = args.agent_dir.expanduser().resolve()
    state_dir = args.state_dir.expanduser().resolve()
    if args.status:
        return status(agent_dir)
    if args.uninstall:
        return uninstall(agent_dir, state_dir, not args.skip_restore)
    return install(agent_dir)


if __name__ == "__main__":
    sys.exit(main())
