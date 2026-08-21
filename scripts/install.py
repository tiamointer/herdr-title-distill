#!/usr/bin/env python3
"""Install, migrate, inspect, or remove the Herdr title distillation service."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
SOURCE_EXTENSION = SKILL_ROOT / "extension" / "index.ts"
SOURCE_DAEMON = SKILL_ROOT / "scripts" / "daemon.ts"
DEFAULT_AGENT_DIR = Path(
    os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent"
).expanduser()
SKILL_NAME = "herdr-title-distill"
LEGACY_SKILL_NAME = "omp-herdr-title-sync"
LEGACY_PROJECT_ROOT = SKILL_ROOT.with_name(LEGACY_SKILL_NAME)
TARGET_NAME = f"{SKILL_NAME}.ts"
LEGACY_TARGET_NAME = f"{LEGACY_SKILL_NAME}.ts"
DEFAULT_STATE_ROOT = Path.home() / ".config" / SKILL_NAME
DEFAULT_STATE_DIR = DEFAULT_STATE_ROOT / "state"
LEGACY_STATE_DIR = Path.home() / ".config" / LEGACY_SKILL_NAME / "state"
DEFAULT_SKILL_DIR = Path.home() / ".agents" / "skills"
SERVICE_LABEL = "com.laike.herdr-title-distill"
DEFAULT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve(strict=False) == right.resolve(strict=False)
    except OSError:
        return False


def owned_symlink(target: Path, destinations: list[Path]) -> bool:
    if not target.is_symlink():
        return False
    return any(same_path(target, destination) for destination in destinations)


def installed_skill_root(target: Path) -> Path | None:
    if not target.is_symlink():
        return None
    try:
        extension = target.resolve(strict=True)
        root = extension.parent.parent
        metadata = (root / "SKILL.md").read_text(encoding="utf-8").splitlines()[:20]
    except OSError:
        return None
    if extension != root / "extension" / "index.ts":
        return None
    names = {f"name: {SKILL_NAME}", f"name: {LEGACY_SKILL_NAME}"}
    return root if any(line.strip() in names for line in metadata) else None


def point_symlink(target: Path, destination: Path) -> None:
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        temporary.symlink_to(destination)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def migrate_state(source_dirs: list[Path], state_dir: Path) -> int:
    migrated = 0
    for source_dir in dict.fromkeys(source_dirs):
        if not source_dir.is_dir() or same_path(source_dir, state_dir):
            continue
        state_dir.mkdir(parents=True, exist_ok=True)
        for source in source_dir.glob("*.json"):
            destination = state_dir / source.name
            if destination.exists() and destination.stat().st_mtime > source.stat().st_mtime:
                continue
            shutil.copy2(source, destination)
            migrated += 1
    return migrated


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
    args.append(original if isinstance(original, str) and original else "--clear")
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
    if shutil.which("herdr") is None:
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


def daemon_environment(state_dir: Path) -> dict[str, str]:
    environment: dict[str, str] = {
        "HERDR_TITLE_DISTILL_STATE_DIR": str(state_dir),
        "HERDR_TITLE_DISTILL_LOG": str(state_dir.parent / "service.log"),
        "PATH": os.environ.get(
            "PATH",
            f"{Path.home()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ),
    }
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if socket_path:
        environment["HERDR_TITLE_DISTILL_SOCKET_PATH"] = socket_path
    return environment


def write_launch_agent(plist_path: Path, state_dir: Path) -> None:
    bun_path = shutil.which("bun")
    if bun_path is None:
        raise RuntimeError("bun-not-found")
    payload = {
        "Label": SERVICE_LABEL,
        "ProgramArguments": [bun_path, str(SOURCE_DAEMON)],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
        "WorkingDirectory": str(SKILL_ROOT),
        "EnvironmentVariables": daemon_environment(state_dir),
        "StandardOutPath": str(state_dir.parent / "service.stdout.log"),
        "StandardErrorPath": str(state_dir.parent / "service.stderr.log"),
        "ThrottleInterval": 5,
    }
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = plist_path.with_name(f".{plist_path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as handle:
        plistlib.dump(payload, handle, sort_keys=True)
    os.replace(temporary, plist_path)


def launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["launchctl", *args],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def service_loaded() -> bool:
    if sys.platform != "darwin":
        return False
    return launchctl("print", f"gui/{os.getuid()}/{SERVICE_LABEL}").returncode == 0


def restart_service(plist_path: Path) -> str:
    if sys.platform != "darwin":
        return "unsupported-platform"
    domain = f"gui/{os.getuid()}"
    if service_loaded():
        launchctl("bootout", domain, str(plist_path))
    boot = launchctl("bootstrap", domain, str(plist_path))
    if boot.returncode != 0:
        raise RuntimeError(boot.stderr.strip() or "launchctl-bootstrap-failed")
    launchctl("kickstart", "-k", f"{domain}/{SERVICE_LABEL}")
    return "running" if service_loaded() else "load-failed"


def stop_service(plist_path: Path) -> str:
    if sys.platform != "darwin":
        return "unsupported-platform"
    if not service_loaded():
        return "not-loaded"
    completed = launchctl("bootout", f"gui/{os.getuid()}", str(plist_path))
    return "stopped" if completed.returncode == 0 else "stop-failed"


def install(
    agent_dir: Path,
    state_dir: Path,
    skill_dir: Path,
    plist_path: Path,
    start_service: bool,
    legacy_state_dir: Path,
    legacy_project_root: Path,
) -> int:
    if not SOURCE_EXTENSION.is_file() or not SOURCE_DAEMON.is_file():
        emit({"status": "error", "reason": "source-missing", "source": str(SKILL_ROOT)})
        return 2
    skill_dir.mkdir(parents=True, exist_ok=True)


    extensions_dir = agent_dir / "extensions"
    extensions_dir.mkdir(parents=True, exist_ok=True)
    target = extensions_dir / TARGET_NAME
    legacy_target = extensions_dir / LEGACY_TARGET_NAME
    skill_target = skill_dir / SKILL_NAME
    legacy_skill_target = skill_dir / LEGACY_SKILL_NAME

    legacy_source_extension = legacy_project_root / "extension" / "index.ts"
    allowed_extension_sources = [SOURCE_EXTENSION, legacy_source_extension]
    previous_root = installed_skill_root(target)
    if target.exists() or target.is_symlink():
        if not owned_symlink(target, allowed_extension_sources) and previous_root is None:
            emit({"status": "error", "reason": "target-collision", "target": str(target)})
            return 2

    legacy_root = installed_skill_root(legacy_target)
    if legacy_target.exists() or legacy_target.is_symlink():
        if legacy_root is None and not owned_symlink(legacy_target, allowed_extension_sources):
            emit({"status": "error", "reason": "legacy-target-not-owned", "target": str(legacy_target)})
            return 2

    if skill_target.exists() or skill_target.is_symlink():
        if not owned_symlink(skill_target, [SKILL_ROOT, legacy_project_root]):
            emit({"status": "error", "reason": "skill-target-collision", "target": str(skill_target)})
            return 2
    if legacy_skill_target.exists() or legacy_skill_target.is_symlink():
        if (
            not owned_symlink(legacy_skill_target, [SKILL_ROOT, legacy_project_root])
            and installed_skill_root(legacy_target) is None
        ):
            emit({"status": "error", "reason": "legacy-skill-not-owned", "target": str(legacy_skill_target)})
            return 2

    source_state_dirs = [legacy_state_dir, legacy_project_root / "state", SKILL_ROOT / "state"]
    if previous_root is not None:
        source_state_dirs.append(previous_root / "state")
    if legacy_root is not None:
        source_state_dirs.append(legacy_root / "state")
    migrated = migrate_state(source_state_dirs, state_dir)

    point_symlink(target, SOURCE_EXTENSION)
    point_symlink(skill_target, SKILL_ROOT)
    obsolete: list[str] = []
    if legacy_target.is_symlink():
        legacy_target.unlink()
        obsolete.append(str(legacy_target))
    if legacy_skill_target.is_symlink():
        legacy_skill_target.unlink()
        obsolete.append(str(legacy_skill_target))

    write_launch_agent(plist_path, state_dir)
    service = restart_service(plist_path) if start_service else "not-started"
    emit(
        {
            "status": "installed",
            "source": str(SKILL_ROOT),
            "extension_target": str(target),
            "skill_target": str(skill_target),
            "plist": str(plist_path),
            "service": service,
            "state_dir": str(state_dir),
            "state_files_migrated": migrated,
            "obsolete_registrations_removed": obsolete,
        }
    )
    return 0


def uninstall(
    agent_dir: Path,
    state_dir: Path,
    skill_dir: Path,
    plist_path: Path,
    restore_labels: bool,
) -> int:
    target = agent_dir / "extensions" / TARGET_NAME
    skill_target = skill_dir / SKILL_NAME
    restoration = restore_owned_labels(state_dir) if restore_labels else {"status": "skipped"}
    service = stop_service(plist_path)
    removed: list[str] = []
    for candidate, destinations in (
        (target, [SOURCE_EXTENSION]),
        (skill_target, [SKILL_ROOT]),
    ):
        if not candidate.exists() and not candidate.is_symlink():
            continue
        if not owned_symlink(candidate, destinations):
            emit({"status": "error", "reason": "target-not-owned", "target": str(candidate)})
            return 2
        candidate.unlink()
        removed.append(str(candidate))
    plist_path.unlink(missing_ok=True)
    emit({"status": "uninstalled", "removed": removed, "service": service, "label_restoration": restoration})
    return 0


def status(agent_dir: Path, skill_dir: Path, plist_path: Path) -> int:
    target = agent_dir / "extensions" / TARGET_NAME
    legacy_target = agent_dir / "extensions" / LEGACY_TARGET_NAME
    skill_target = skill_dir / SKILL_NAME
    legacy_skill_target = skill_dir / LEGACY_SKILL_NAME
    installed = owned_symlink(target, [SOURCE_EXTENSION]) and owned_symlink(skill_target, [SKILL_ROOT])
    legacy_extension_active = legacy_target.exists() or legacy_target.is_symlink()
    legacy_skill_active = legacy_skill_target.exists() or legacy_skill_target.is_symlink()
    legacy_active = legacy_extension_active or legacy_skill_active
    payload = {
        "status": "installed" if installed and not legacy_active else "not-installed",
        "source": str(SKILL_ROOT),
        "extension_target": str(target),
        "skill_target": str(skill_target),
        "service": "running" if service_loaded() else "stopped",
        "plist": str(plist_path),
        "legacy_registration_active": legacy_active,
        "legacy_extension_registration_active": legacy_extension_active,
        "legacy_skill_registration_active": legacy_skill_active,
    }
    emit(payload)
    return 0 if payload["status"] == "installed" else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--uninstall", action="store_true", help="remove only this package's registrations")
    mode.add_argument("--status", action="store_true", help="show installation status")
    parser.add_argument("--agent-dir", type=Path, default=DEFAULT_AGENT_DIR)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--skill-dir", type=Path, default=DEFAULT_SKILL_DIR)
    parser.add_argument("--plist", type=Path, default=DEFAULT_PLIST)
    parser.add_argument("--legacy-state-dir", type=Path, default=LEGACY_STATE_DIR)
    parser.add_argument("--legacy-project-root", type=Path, default=LEGACY_PROJECT_ROOT)
    parser.add_argument("--skip-service", action="store_true", help="write registration without loading launchd")
    parser.add_argument("--skip-restore", action="store_true", help="do not restore labels during uninstall")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    agent_dir = args.agent_dir.expanduser().resolve()
    state_dir = args.state_dir.expanduser().resolve()
    skill_dir = args.skill_dir.expanduser().resolve()
    plist_path = args.plist.expanduser().resolve()
    legacy_state_dir = args.legacy_state_dir.expanduser().resolve()
    legacy_project_root = args.legacy_project_root.expanduser().resolve()
    if args.status:
        return status(agent_dir, skill_dir, plist_path)
    if args.uninstall:
        return uninstall(agent_dir, state_dir, skill_dir, plist_path, not args.skip_restore)
    try:
        return install(
            agent_dir,
            state_dir,
            skill_dir,
            plist_path,
            not args.skip_service,
            legacy_state_dir,
            legacy_project_root,
        )
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        emit({"status": "error", "reason": str(error)})
        return 2


if __name__ == "__main__":
    sys.exit(main())
