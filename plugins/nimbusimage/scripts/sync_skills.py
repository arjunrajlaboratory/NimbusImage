#!/usr/bin/env python3
"""Synchronize shared NimbusImage skills into repository agent packages."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parents[1]
PLUGIN_SKILLS_ROOT = PLUGIN_ROOT / "skills"
LEGACY_COMMANDS_ROOT = PLUGIN_ROOT / "commands"
LEGACY_CODEX_SKILLS_ROOT = PLUGIN_ROOT / "codex-skills"
PROJECT_SKILLS_ROOT = REPO_ROOT / ".claude" / "skills"
CODEX_REPO_SKILLS_ROOT = REPO_ROOT / ".agents" / "skills"
CLAUDE_MARKETPLACE_PATH = REPO_ROOT / ".claude-plugin" / "marketplace.json"
CODEX_MARKETPLACE_PATH = REPO_ROOT / ".agents" / "plugins" / "marketplace.json"

SKILLS = {
    "nimbusimage": "nimbusimage",
    "annotations": "nimbusimage-annotations",
    "images": "nimbusimage-images",
    "workers": "nimbusimage-workers",
    "analyze": "nimbusimage-analyze",
}
REFERENCE_FILES = ("api-overview.md", "gotchas.md")


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def replace_tree(source: Path, target: Path) -> None:
    remove_path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)


def write_text_if_changed(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text(encoding="utf-8") != content:
        path.write_text(content, encoding="utf-8")


def render_repo_skill(skill_text: str, plugin_name: str, repo_name: str) -> str:
    expected = f"name: {plugin_name}\n"
    replacement = f"name: {repo_name}\n"
    if expected not in skill_text:
        raise ValueError(f"Shared skill {plugin_name} has an invalid name")
    return skill_text.replace(expected, replacement, 1)


def expected_repo_skill_names() -> set[str]:
    project_skill_names = {
        source_skill.name
        for source_skill in PROJECT_SKILLS_ROOT.iterdir()
        if (source_skill / "SKILL.md").is_file()
    }
    return project_skill_names | set(SKILLS.values())


def unexpected_repo_skills(
    skills_root: Path,
    expected_names: set[str],
) -> list[Path]:
    if not skills_root.is_dir():
        return []
    return sorted(
        (
            path
            for path in skills_root.iterdir()
            if (path.is_dir() or path.is_symlink())
            and path.name not in expected_names
        ),
        key=lambda path: path.name,
    )


def write_generated_skills() -> None:
    for plugin_name in SKILLS:
        skill_root = PLUGIN_SKILLS_ROOT / plugin_name
        references_root = skill_root / "references"
        references_root.mkdir(parents=True, exist_ok=True)
        for reference_name in REFERENCE_FILES:
            shutil.copy2(
                PLUGIN_ROOT / "references" / reference_name,
                references_root / reference_name,
            )

    for source_skill in sorted(PROJECT_SKILLS_ROOT.iterdir()):
        if (source_skill / "SKILL.md").is_file():
            replace_tree(source_skill, CODEX_REPO_SKILLS_ROOT / source_skill.name)

    for plugin_name, repo_name in SKILLS.items():
        source = PLUGIN_SKILLS_ROOT / plugin_name
        target = CODEX_REPO_SKILLS_ROOT / repo_name
        replace_tree(source, target)
        write_text_if_changed(
            target / "SKILL.md",
            render_repo_skill(
                (source / "SKILL.md").read_text(encoding="utf-8"),
                plugin_name,
                repo_name,
            ),
        )

    for unexpected_skill in unexpected_repo_skills(
        CODEX_REPO_SKILLS_ROOT,
        expected_repo_skill_names(),
    ):
        remove_path(unexpected_skill)


def compare_file(expected: Path, actual: Path, errors: list[str]) -> None:
    if not actual.is_file():
        errors.append(f"missing file: {actual.relative_to(REPO_ROOT)}")
        return
    if expected.read_bytes() != actual.read_bytes():
        errors.append(f"stale file: {actual.relative_to(REPO_ROOT)}")


def compare_tree(
    expected: Path,
    actual: Path,
    errors: list[str],
    content_overrides: dict[Path, bytes] | None = None,
) -> None:
    if actual.is_symlink() or not actual.is_dir():
        errors.append(f"stale directory: {actual.relative_to(REPO_ROOT)}")
        return

    expected_files = {
        path.relative_to(expected) for path in expected.rglob("*") if path.is_file()
    }
    actual_files = {
        path.relative_to(actual) for path in actual.rglob("*") if path.is_file()
    }
    for relative_path in sorted(expected_files | actual_files):
        expected_path = expected / relative_path
        actual_path = actual / relative_path
        if relative_path not in expected_files:
            errors.append(f"unexpected file: {actual_path.relative_to(REPO_ROOT)}")
        elif relative_path not in actual_files:
            errors.append(f"missing file: {actual_path.relative_to(REPO_ROOT)}")
        elif content_overrides and relative_path in content_overrides:
            if content_overrides[relative_path] != actual_path.read_bytes():
                errors.append(f"stale file: {actual_path.relative_to(REPO_ROOT)}")
        else:
            compare_file(expected_path, actual_path, errors)


def validate_codex_marketplace(
    marketplace: dict[str, object],
    errors: list[str],
) -> None:
    if marketplace.get("name") != "NimbusImage":
        errors.append("Codex marketplace name must be NimbusImage")
    interface = marketplace.get("interface")
    if not isinstance(interface, dict) or interface.get("displayName") != "NimbusImage":
        errors.append("Codex marketplace display name must be NimbusImage")

    plugins = marketplace.get("plugins")
    entry = None
    if isinstance(plugins, list):
        entry = next(
            (
                item
                for item in plugins
                if isinstance(item, dict) and item.get("name") == "nimbusimage"
            ),
            None,
        )
    if entry is None or entry.get("source") != {
        "source": "local",
        "path": "./plugins/nimbusimage",
    }:
        errors.append(
            "Codex marketplace must expose nimbusimage with a local source object"
        )
        return
    if entry.get("policy") != {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    }:
        errors.append("Codex marketplace must define installation and auth policies")
    if entry.get("category") != "Developer Tools":
        errors.append("Codex marketplace category must be Developer Tools")


def validate_metadata(errors: list[str]) -> None:
    claude_marketplace = json.loads(
        CLAUDE_MARKETPLACE_PATH.read_text(encoding="utf-8")
    )
    codex_marketplace = json.loads(
        CODEX_MARKETPLACE_PATH.read_text(encoding="utf-8")
    )
    codex_manifest = json.loads(
        (PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
    )
    claude_manifest = json.loads(
        (PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(
            encoding="utf-8"
        )
    )

    entry = next(
        (
            item
            for item in claude_marketplace.get("plugins", [])
            if item.get("name") == "nimbusimage"
        ),
        None,
    )
    if claude_marketplace.get("name") != "NimbusImage":
        errors.append("Claude marketplace name must be NimbusImage")
    if entry is None or entry.get("source") != "./plugins/nimbusimage":
        errors.append(
            "Claude marketplace must expose nimbusimage from ./plugins/nimbusimage"
        )
    validate_codex_marketplace(codex_marketplace, errors)
    if codex_manifest.get("name") != "nimbusimage":
        errors.append("Codex plugin name must be nimbusimage")
    if codex_manifest.get("skills") != "./skills/":
        errors.append("Codex plugin skills path must be ./skills/")
    if claude_manifest.get("name") != "nimbus-skills":
        errors.append("Claude runtime namespace must remain nimbus-skills")
    if claude_manifest.get("skills") != "./skills/":
        errors.append("Claude plugin skills path must be ./skills/")
    if "commands" in claude_manifest:
        errors.append("Claude plugin must not load legacy duplicate commands")
    if claude_manifest.get("version") != codex_manifest.get("version"):
        errors.append("Claude and Codex plugin versions must match")

    documentation_requirements = {
        REPO_ROOT / "README.md": (
            "Python API and agent skills",
            "./plugins/nimbusimage/README.md",
        ),
        REPO_ROOT / "nimbusimage" / "README.md": (
            "Agent integration: Claude Code and Codex",
            "claude plugin install nimbusimage@NimbusImage",
            "codex plugin add nimbusimage@NimbusImage",
        ),
        PLUGIN_ROOT / "README.md": (
            "claude plugin install nimbusimage@NimbusImage",
            "codex plugin add nimbusimage@NimbusImage",
            "python3 plugins/nimbusimage/scripts/sync_skills.py --check",
        ),
    }
    for documentation_path, required_values in documentation_requirements.items():
        documentation = documentation_path.read_text(encoding="utf-8")
        for required in required_values:
            if required not in documentation:
                errors.append(
                    f"{documentation_path.relative_to(REPO_ROOT)} is missing: "
                    f"{required}"
                )

    agents_path = REPO_ROOT / "AGENTS.md"
    if not agents_path.is_symlink() or os.readlink(agents_path) != "CLAUDE.md":
        errors.append("AGENTS.md must link to the canonical CLAUDE.md guidance")
    guidance = (REPO_ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    if "Bash(" in guidance or "pre-approved for Claude Code" in guidance:
        errors.append("CLAUDE.md still contains provider-specific permission syntax")


def check_generated_skills() -> list[str]:
    errors: list[str] = []
    for legacy_root in (LEGACY_COMMANDS_ROOT, LEGACY_CODEX_SKILLS_ROOT):
        if legacy_root.exists():
            errors.append(
                "obsolete duplicate skill source: "
                f"{legacy_root.relative_to(REPO_ROOT)}"
            )

    for plugin_name in SKILLS:
        skill_root = PLUGIN_SKILLS_ROOT / plugin_name
        actual_skill = skill_root / "SKILL.md"
        if not actual_skill.is_file():
            errors.append(f"missing file: {actual_skill.relative_to(REPO_ROOT)}")
        elif f"name: {plugin_name}\n" not in actual_skill.read_text(encoding="utf-8"):
            errors.append(f"invalid skill name: {actual_skill.relative_to(REPO_ROOT)}")

        if not (skill_root / "agents" / "openai.yaml").is_file():
            metadata_path = skill_root / "agents" / "openai.yaml"
            errors.append(
                f"missing file: {metadata_path.relative_to(REPO_ROOT)}"
            )
        for reference_name in REFERENCE_FILES:
            compare_file(
                PLUGIN_ROOT / "references" / reference_name,
                skill_root / "references" / reference_name,
                errors,
            )

    for source_skill in sorted(PROJECT_SKILLS_ROOT.iterdir()):
        if (source_skill / "SKILL.md").is_file():
            compare_tree(
                source_skill,
                CODEX_REPO_SKILLS_ROOT / source_skill.name,
                errors,
            )

    for plugin_name, repo_name in SKILLS.items():
        source = PLUGIN_SKILLS_ROOT / plugin_name
        compare_tree(
            source,
            CODEX_REPO_SKILLS_ROOT / repo_name,
            errors,
            {
                Path("SKILL.md"): render_repo_skill(
                    (source / "SKILL.md").read_text(encoding="utf-8"),
                    plugin_name,
                    repo_name,
                ).encode("utf-8")
            },
        )

    for unexpected_skill in unexpected_repo_skills(
        CODEX_REPO_SKILLS_ROOT,
        expected_repo_skill_names(),
    ):
        errors.append(
            "unexpected repository-local skill: "
            f"{unexpected_skill.relative_to(REPO_ROOT)}"
        )

    validate_metadata(errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="synchronize skill copies")
    mode.add_argument(
        "--check", action="store_true", help="fail when synchronized files drift"
    )
    args = parser.parse_args()

    if args.write:
        write_generated_skills()

    errors = check_generated_skills()
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        if args.check:
            print(
                "Run python3 plugins/nimbusimage/scripts/sync_skills.py --write",
                file=sys.stderr,
            )
        return 1

    print("NimbusImage Claude and Codex skills are synchronized.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
