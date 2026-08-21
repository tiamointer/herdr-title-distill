#!/usr/bin/env python3
"""Verify Herdr title distillation adapters, migration, ownership safety, and live behavior."""

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
INSTALLER = SKILL_ROOT / "scripts" / "install.py"
DAEMON = SKILL_ROOT / "scripts" / "daemon.ts"
LIVE_SYNC = SKILL_ROOT / "scripts" / "live_sync.ts"
RUNTIME_CHECK = SKILL_ROOT / "tests" / "runtime_check.ts"
TARGET_NAME = "herdr-title-distill.ts"
LEGACY_NAME = "omp-herdr-title-sync"
LEGACY_TARGET_NAME = f"{LEGACY_NAME}.ts"


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
    except json.JSONDecodeError as error:
        raise AssertionError(f"{context} returned invalid JSON: {completed.stdout}") from error
    require(isinstance(payload, dict), f"{context} did not return an object")
    return payload


def nested_record(payload: dict[str, Any], *keys: str) -> dict[str, Any]:
    current: Any = payload
    for key in keys:
        require(isinstance(current, dict), f"missing object before {key}")
        current = current.get(key)
    require(isinstance(current, dict), f"missing object at {'.'.join(keys)}")
    return current


def herdr_json(*args: str, timeout: float = 10) -> dict[str, Any]:
    return parse_json_output(run(["herdr", *args], timeout=timeout), f"herdr {' '.join(args)}")


def herdr_command(*args: str, timeout: float = 10) -> None:
    completed = run(["herdr", *args], timeout=timeout)
    require(
        completed.returncode == 0,
        f"herdr {' '.join(args)} failed ({completed.returncode}): {completed.stderr or completed.stdout}",
    )


def verify_source_contract() -> dict[str, Any]:
    sources = {
        "core": (SKILL_ROOT / "src" / "core.ts").read_text(encoding="utf-8"),
        "adapters": (SKILL_ROOT / "src" / "adapters.ts").read_text(encoding="utf-8"),
        "service": (SKILL_ROOT / "src" / "service.ts").read_text(encoding="utf-8"),
        "model": (SKILL_ROOT / "src" / "model.ts").read_text(encoding="utf-8"),
        "daemon": DAEMON.read_text(encoding="utf-8"),
        "extension": (SKILL_ROOT / "extension" / "index.ts").read_text(encoding="utf-8"),
    }
    required = {
        "core": ["agent.list", "pane.get", "pane.rename", "tab.get", "tab.rename", "multi-pane-preserved"],
        "adapters": ["omp", "pi", "claude", "codex", "grok", "copilot", "hermes", "bun:sqlite"],
        "service": ["extractDistillContext", "completedTransition", "stale-generation-discarded", "title-synced"],
        "model": ["HERDR_TITLE_DISTILL_MODEL", "--no-session", "--no-tools", '"12000"'],
        "daemon": ["DistillService", "service.start()", "HERDR_TITLE_DISTILL_STATE_DIR"],
        "extension": ["Compatibility extension", "herdrTitleDistillExtension"],
    }
    missing = {
        name: [token for token in tokens if token not in sources[name]]
        for name, tokens in required.items()
        if any(token not in sources[name] for token in tokens)
    }
    require(not missing, f"runtime contract tokens missing: {missing}")
    require("pi.on(" not in sources["extension"], "compatibility extension still owns per-session runtime")
    require("Bun.spawn" not in sources["extension"], "compatibility extension starts subprocesses")
    require("fetch(" not in sources["extension"], "compatibility extension performs network requests")

    allowed_legacy_files = {
        "README.md",
        "SKILL.md",
        "scripts/install.py",
        "scripts/verify.py",
        "src/core.ts",
    }
    legacy_hits: list[str] = []
    old_environment_prefix = "OMP_HERDR_" + "TITLE_SYNC"
    old_environment_hits: list[str] = []
    for file_path in SKILL_ROOT.rglob("*"):
        if not file_path.is_file() or ".git" in file_path.parts or "__pycache__" in file_path.parts:
            continue
        if file_path.suffix not in {".ts", ".py", ".md", ".yaml", ".json"}:
            continue
        try:
            text = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        relative = str(file_path.relative_to(SKILL_ROOT))
        if LEGACY_NAME in text and relative not in allowed_legacy_files:
            legacy_hits.append(relative)
        if old_environment_prefix in text:
            old_environment_hits.append(relative)
    require(not legacy_hits, f"legacy identifier escaped migration boundary: {legacy_hits}")
    require(not old_environment_hits, f"obsolete environment prefix remains: {old_environment_hits}")
    return {
        "service": "herdr-title-distill",
        "supported_harnesses": 7,
        "legacy_boundary_files": sorted(allowed_legacy_files),
        "compatibility_extension_passive": True,
    }


def installer_command(temp_root: Path) -> list[str]:
    return [
        sys.executable,
        str(INSTALLER),
        "--agent-dir",
        str(temp_root / "agent"),
        "--state-dir",
        str(temp_root / "new-state"),
        "--skill-dir",
        str(temp_root / "skills"),
        "--plist",
        str(temp_root / "service.plist"),
        "--legacy-state-dir",
        str(temp_root / "legacy-state"),
        "--legacy-project-root",
        str(temp_root / LEGACY_NAME),
        "--skip-service",
    ]


def verify_installer_lifecycle(temp_root: Path) -> dict[str, Any]:
    command = installer_command(temp_root)
    extensions_dir = temp_root / "agent" / "extensions"
    skill_dir = temp_root / "skills"
    extensions_dir.mkdir(parents=True)
    keep_extension = extensions_dir / "keep.ts"
    keep_extension.write_text("export default () => {};\n", encoding="utf-8")
    keep_skill = skill_dir / "keep-skill" / "SKILL.md"
    keep_skill.parent.mkdir(parents=True)
    keep_skill.write_text("---\nname: keep-skill\n---\n", encoding="utf-8")

    target = extensions_dir / TARGET_NAME
    skill_target = skill_dir / "herdr-title-distill"
    legacy_target = extensions_dir / LEGACY_TARGET_NAME
    legacy_skill_target = skill_dir / LEGACY_NAME

    first = parse_json_output(run(command), "sandbox first install")
    require(first.get("status") == "installed", str(first))
    require(target.is_symlink(), "new extension link missing")
    require(skill_target.is_symlink(), "new skill link missing")
    require(target.resolve() == (SKILL_ROOT / "extension" / "index.ts").resolve(), "extension link is wrong")
    require(skill_target.resolve() == SKILL_ROOT.resolve(), "skill link is wrong")
    require((temp_root / "service.plist").is_file(), "launchd plist was not written")

    status = parse_json_output(run([*command, "--status"]), "sandbox status")
    require(status.get("status") == "installed", str(status))
    require(status.get("legacy_registration_active") is False, str(status))
    repeat = parse_json_output(run(command), "sandbox repeat install")
    require(repeat.get("status") == "installed", str(repeat))

    removed = parse_json_output(
        run([*command, "--uninstall", "--skip-restore"]),
        "sandbox uninstall",
    )
    require(removed.get("status") == "uninstalled", str(removed))
    require(not target.exists() and not target.is_symlink(), "uninstall left extension link")
    require(not skill_target.exists() and not skill_target.is_symlink(), "uninstall left skill link")
    require(keep_extension.read_text(encoding="utf-8") == "export default () => {};\n", "unrelated extension changed")
    require("keep-skill" in keep_skill.read_text(encoding="utf-8"), "unrelated skill changed")

    legacy_state_dir = temp_root / "legacy-state"
    legacy_state_dir.mkdir(parents=True)
    legacy_state = legacy_state_dir / "term-legacy.json"
    legacy_payload = {
        "version": 1,
        "terminal_id": "term-legacy",
        "pane": {"pane_id": "w:p", "last_auto_label": "旧自动名", "original_label": None},
        "tabs": {},
    }
    legacy_state.write_text(f"{json.dumps(legacy_payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    dangling_root = temp_root / LEGACY_NAME
    legacy_target.symlink_to(dangling_root / "extension" / "index.ts")
    legacy_skill_target.symlink_to(dangling_root)
    require(legacy_target.is_symlink() and not legacy_target.exists(), "legacy extension fixture is not dangling")
    require(legacy_skill_target.is_symlink() and not legacy_skill_target.exists(), "legacy skill fixture is not dangling")

    migrated = parse_json_output(run(command), "sandbox legacy migration")
    require(migrated.get("status") == "installed", str(migrated))
    require(migrated.get("state_files_migrated") == 1, str(migrated))
    require(not legacy_target.exists() and not legacy_target.is_symlink(), "legacy extension remained active")
    require(not legacy_skill_target.exists() and not legacy_skill_target.is_symlink(), "legacy skill remained active")
    migrated_state = temp_root / "new-state" / legacy_state.name
    require(migrated_state.read_text(encoding="utf-8") == legacy_state.read_text(encoding="utf-8"), "state changed in migration")
    migrated_status = parse_json_output(run([*command, "--status"]), "sandbox migrated status")
    require(migrated_status.get("legacy_extension_registration_active") is False, str(migrated_status))
    require(migrated_status.get("legacy_skill_registration_active") is False, str(migrated_status))

    parse_json_output(
        run([*command, "--uninstall", "--skip-restore"]),
        "sandbox post-migration uninstall",
    )
    target.write_text("user-owned\n", encoding="utf-8")
    collision = run(command)
    require(collision.returncode == 2, "unowned target collision did not fail")
    require(target.read_text(encoding="utf-8") == "user-owned\n", "unowned target was overwritten")
    target.unlink()

    return {
        "first_install": first.get("status"),
        "repeat_install": repeat.get("status"),
        "dangling_legacy_links_migrated": True,
        "ownership_state_preserved": True,
        "legacy_registrations_removed": True,
        "unrelated_files_preserved": True,
        "collision_preserved": True,
    }


def verify_isolated() -> dict[str, Any]:
    require(shutil.which("bun") is not None, "bun is required")
    source = verify_source_contract()
    runtime = parse_json_output(run(["bun", str(RUNTIME_CHECK)], timeout=60), "runtime fixtures")
    with tempfile.TemporaryDirectory(prefix="herdr-title-distill-verify-") as temporary:
        temp_root = Path(temporary)
        installer = verify_installer_lifecycle(temp_root)
        bundle = run(
            [
                "bun",
                "build",
                str(DAEMON),
                "--target=bun",
                f"--outfile={temp_root / 'daemon.js'}",
            ],
            timeout=30,
        )
        require(bundle.returncode == 0, f"daemon build failed: {bundle.stderr or bundle.stdout}")
        require((temp_root / "daemon.js").is_file(), "daemon build emitted no artifact")
    return {
        "status": "pass",
        "source": source,
        "runtime": runtime,
        "installer": installer,
        "daemon_build": "pass",
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


def close_tab(tab_id: str) -> None:
    run(["herdr", "tab", "close", tab_id], timeout=10)


def pane_info(pane_id: str) -> dict[str, Any]:
    return nested_record(herdr_json("pane", "get", pane_id), "result", "pane")


def tab_info(tab_id: str) -> dict[str, Any]:
    return nested_record(herdr_json("tab", "get", tab_id), "result", "tab")


def agent_info(pane_id: str) -> dict[str, Any] | None:
    payload = herdr_json("agent", "list")
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    records = result.get("panes")
    if not isinstance(records, list):
        records = result.get("agents")
    if not isinstance(records, list):
        return None
    return next(
        (record for record in records if isinstance(record, dict) and record.get("pane_id") == pane_id),
        None,
    )


def pane_tail(pane_id: str) -> str:
    completed = run(
        [
            "herdr",
            "pane",
            "read",
            pane_id,
            "--source",
            "recent-unwrapped",
            "--lines",
            "80",
            "--format",
            "text",
        ],
        timeout=10,
    )
    text = completed.stdout or completed.stderr
    return text[-4000:]


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


def verify_live_protection(workspace_id: str, temp_root: Path) -> dict[str, Any]:
    state_dir = temp_root / "direct-state"
    tab_id, pane_id = create_test_tab(workspace_id, temp_root)
    try:
        first = live_sync(pane_id, "保护基线", state_dir)
        require(first.get("pane_status") == "renamed", str(first))
        require(first.get("tab_status") == "renamed", str(first))
        require(pane_info(pane_id).get("label") == "保护基线", "pane label did not sync")
        require(tab_info(tab_id).get("label") == "保护基线", "single-pane tab did not sync")

        split = herdr_json("pane", "split", pane_id, "--direction", "right", "--no-focus")
        second_pane = nested_record(split, "result", "pane").get("pane_id")
        require(isinstance(second_pane, str), "pane split omitted pane id")
        multi = live_sync(pane_id, "多窗标题", state_dir)
        require(multi.get("tab_status") == "multi-pane-preserved", str(multi))
        require(tab_info(tab_id).get("label") == "保护基线", "multi-pane tab changed")

        herdr_command("pane", "rename", pane_id, "手工窗")
        manual_pane = live_sync(pane_id, "手工保护", state_dir)
        require(manual_pane.get("pane_status") == "manual-protected", str(manual_pane))
        require(pane_info(pane_id).get("label") == "手工窗", "manual pane label was overwritten")

        herdr_json("pane", "close", second_pane)
        herdr_command("tab", "rename", tab_id, "手工页")
        herdr_command("pane", "rename", pane_id, "--clear")
        manual_tab = live_sync(pane_id, "恢复命名", state_dir)
        require(manual_tab.get("pane_status") == "renamed", str(manual_tab))
        require(manual_tab.get("tab_status") == "manual-protected", str(manual_tab))
        require(pane_info(pane_id).get("label") == "恢复命名", "cleared pane did not resume naming")
        require(tab_info(tab_id).get("label") == "手工页", "manual tab label was overwritten")
        return {
            "single_pane_synced": True,
            "multi_pane_tab_preserved": True,
            "manual_pane_preserved": True,
            "manual_tab_preserved": True,
        }
    finally:
        close_tab(tab_id)


def valid_goal_label(
    pane_label: Any,
    tab_label: Any,
    previous: str | None,
    semantic_terms: tuple[str, ...],
    forbidden_terms: tuple[str, ...],
) -> bool:
    if not isinstance(pane_label, str) or pane_label != tab_label or pane_label == previous:
        return False
    if pane_label.isdigit() or not 2 <= len(pane_label) <= 10:
        return False
    folded = pane_label.casefold()
    if not any(term.casefold() in folded for term in semantic_terms):
        return False
    return not any(term.casefold() in folded for term in forbidden_terms)


def wait_for_goal_title(
    *,
    harness: str,
    pane_id: str,
    tab_id: str,
    previous_title: str | None,
    previous_revision: int | None,
    semantic_terms: tuple[str, ...],
    forbidden_terms: tuple[str, ...] = (),
    completion_timeout: float = 150,
) -> tuple[str, float, int | None]:
    overall_deadline = time.monotonic() + completion_timeout
    completion_at: float | None = None
    saw_active = False
    last_status: Any = None
    last_revision: Any = None
    last_pane_label: Any = None
    last_tab_label: Any = None
    while time.monotonic() < overall_deadline:
        now = time.monotonic()
        record = agent_info(pane_id)
        if record is not None:
            record_harness = str(record.get("agent") or "").lower()
            if record_harness in {harness, "claude-code" if harness == "claude" else harness}:
                last_status = record.get("agent_status")
                last_revision = record.get("revision")
                if last_status in {"working", "blocked"}:
                    saw_active = True
                completed_turn = last_status in {"idle", "done"} and (
                    saw_active
                    or previous_revision is None
                    or isinstance(last_revision, int) and last_revision != previous_revision
                )
                if completed_turn and completion_at is None:
                    completion_at = now
        last_pane_label = pane_info(pane_id).get("label")
        last_tab_label = tab_info(tab_id).get("label")
        if completion_at is not None and valid_goal_label(
            last_pane_label,
            last_tab_label,
            previous_title,
            semantic_terms,
            forbidden_terms,
        ):
            latency = now - completion_at
            require(latency <= 30, f"{harness} title exceeded 30 seconds: {latency:.2f}s")
            return last_pane_label, latency, last_revision if isinstance(last_revision, int) else None
        if completion_at is not None and now - completion_at > 30:
            break
        time.sleep(0.25)
    raise AssertionError(
        f"{harness} title did not converge within deadline "
        f"(status={last_status!r}, revision={last_revision!r}, pane={last_pane_label!r}, "
        f"tab={last_tab_label!r})\n--- pane tail ---\n{pane_tail(pane_id)}"
    )


def harness_command(harness: str, cwd: Path, session_dir: Path, first_prompt: str) -> list[str]:
    if harness == "omp":
        session_dir.mkdir(parents=True)
        verify_model = os.environ.get("HERDR_TITLE_DISTILL_VERIFY_OMP_MODEL", "@smol")
        return [
            "omp",
            "--no-skills",
            "--no-rules",
            "--no-tools",
            "--no-title",
            "--thinking",
            "off",
            "--model",
            verify_model,
            "--system-prompt",
            "只回复‘收到’，不调用工具，不解释。",
            "--max-time",
            "120",
            "--session-dir",
            str(session_dir),
            "--cwd",
            str(cwd),
            first_prompt,
        ]
    if harness == "codex":
        return [
            "codex",
            "--no-alt-screen",
            "--dangerously-bypass-hook-trust",
            "--sandbox",
            "read-only",
            "--ask-for-approval",
            "never",
            "--cd",
            str(cwd),
            first_prompt,
        ]
    if harness == "grok":
        return [
            "grok",
            "--cwd",
            str(cwd),
            "--disable-web-search",
            first_prompt,
        ]
    raise AssertionError(f"unsupported live harness: {harness}")


def verify_real_harness(harness: str, workspace_id: str, temp_root: Path) -> dict[str, Any]:
    harness_root = temp_root / harness
    harness_root.mkdir(parents=True)
    session_dir = harness_root / "sessions"
    working_root = SKILL_ROOT.parent if harness == "codex" else SKILL_ROOT
    tab_id, pane_id = create_test_tab(workspace_id, working_root)
    first_prompt = "当前唯一目标：整理火星发票归档。不要执行工具，只回复‘收到’。"
    second_prompt = "目标彻底改变：现在只修复Safari登录故障；不再整理火星发票。不要执行工具，只回复‘收到’。"
    try:
        command = harness_command(harness, working_root, session_dir, first_prompt)
        herdr_command("pane", "run", pane_id, shlex.join(command), timeout=15)
        first_title, first_latency, first_revision = wait_for_goal_title(
            harness=harness,
            pane_id=pane_id,
            tab_id=tab_id,
            previous_title=None,
            previous_revision=None,
            semantic_terms=("火星", "发票"),
        )

        current = agent_info(pane_id)
        if current is not None and isinstance(current.get("revision"), int):
            first_revision = current["revision"]
        herdr_command("pane", "run", pane_id, second_prompt)
        second_title, second_latency, _ = wait_for_goal_title(
            harness=harness,
            pane_id=pane_id,
            tab_id=tab_id,
            previous_title=first_title,
            previous_revision=first_revision,
            semantic_terms=("Safari", "登录"),
            forbidden_terms=("火星", "发票"),
        )
        require(first_title != second_title, f"{harness}: title did not change")
        return {
            "harness": harness,
            "pane_id": pane_id,
            "first_title": first_title,
            "second_title": second_title,
            "first_latency_seconds": round(first_latency, 3),
            "second_latency_seconds": round(second_latency, 3),
            "single_pane_tab_synced": True,
            "goal_change_observed": True,
        }
    finally:
        close_tab(tab_id)


def verify_live(all_harnesses: bool) -> dict[str, Any]:
    require(all_harnesses, "live verification requires --all-harnesses")
    require(os.environ.get("HERDR_ENV") == "1", "live verification must run inside Herdr")
    require(shutil.which("herdr") is not None, "herdr is not on PATH")
    for command in ("omp", "codex", "grok"):
        require(shutil.which(command) is not None, f"{command} is not on PATH")
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    require(isinstance(workspace_id, str) and workspace_id, "HERDR_WORKSPACE_ID is missing")

    isolated = verify_isolated()
    installation = parse_json_output(run([sys.executable, str(INSTALLER)], timeout=60), "live install/restart")
    require(installation.get("status") == "installed", str(installation))
    status = parse_json_output(run([sys.executable, str(INSTALLER), "--status"]), "live installed status")
    require(status.get("status") == "installed", str(status))
    require(status.get("service") == "running", str(status))
    require(status.get("legacy_registration_active") is False, str(status))
    time.sleep(1)

    with tempfile.TemporaryDirectory(prefix="herdr-title-distill-live-") as temporary:
        temp_root = Path(temporary)
        protection = verify_live_protection(workspace_id, temp_root)
        harness_results = [
            verify_real_harness(harness, workspace_id, temp_root)
            for harness in ("omp", "codex", "grok")
        ]

    return {
        "status": "pass",
        "installation": status,
        "isolated": isolated,
        "protection": protection,
        "real_harnesses": harness_results,
        "fixture_harnesses": ["pi", "claude", "copilot", "hermes"],
        "deadline_seconds": 30,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="exercise real Herdr panes and subscription-backed harnesses")
    parser.add_argument("--all-harnesses", action="store_true", help="include real OMP, Codex, and Grok verification")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        payload = verify_live(args.all_harnesses) if args.live else verify_isolated()
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {"status": "fail", "error": f"{type(error).__name__}: {error}"},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
