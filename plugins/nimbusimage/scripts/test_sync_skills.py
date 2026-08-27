from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("sync_skills.py")
SPEC = importlib.util.spec_from_file_location("sync_skills", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
sync_skills = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_skills)


class MarketplaceValidationTest(unittest.TestCase):
    @staticmethod
    def valid_marketplace() -> dict[str, object]:
        return {
            "name": "NimbusImage",
            "interface": {"displayName": "NimbusImage"},
            "plugins": [
                {
                    "name": "nimbusimage",
                    "source": {
                        "source": "local",
                        "path": "./plugins/nimbusimage",
                    },
                    "policy": {
                        "installation": "AVAILABLE",
                        "authentication": "ON_INSTALL",
                    },
                    "category": "Developer Tools",
                }
            ],
        }

    def test_accepts_codex_marketplace_contract(self) -> None:
        errors: list[str] = []

        sync_skills.validate_codex_marketplace(self.valid_marketplace(), errors)

        self.assertEqual(errors, [])

    def test_rejects_legacy_string_source(self) -> None:
        errors: list[str] = []

        sync_skills.validate_codex_marketplace(
            {
                "name": "NimbusImage",
                "plugins": [
                    {
                        "name": "nimbusimage",
                        "source": "./plugins/nimbusimage",
                    }
                ],
            },
            errors,
        )

        self.assertIn(
            "Codex marketplace must expose nimbusimage with a local source object",
            errors,
        )

    def test_requires_policy_and_category(self) -> None:
        marketplace = self.valid_marketplace()
        plugin = marketplace["plugins"][0]
        del plugin["policy"]
        del plugin["category"]
        errors: list[str] = []

        sync_skills.validate_codex_marketplace(marketplace, errors)

        self.assertIn(
            "Codex marketplace must define installation and auth policies",
            errors,
        )
        self.assertIn(
            "Codex marketplace category must be Developer Tools",
            errors,
        )


class RepositorySkillValidationTest(unittest.TestCase):
    def test_reports_unexpected_skill_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            skills_root = Path(temporary_directory)
            (skills_root / "expected").mkdir()
            (skills_root / "stale-skill").mkdir()

            unexpected = sync_skills.unexpected_repo_skills(
                skills_root,
                {"expected"},
            )

        self.assertEqual([path.name for path in unexpected], ["stale-skill"])


class ReferenceSynchronizationTest(unittest.TestCase):
    def test_replaces_reference_trees_and_removes_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            source_root = temporary_root / "source"
            target_root = temporary_root / "target"
            source_root.mkdir()
            target_root.mkdir()
            (source_root / "api-overview.md").write_text(
                "current API",
                encoding="utf-8",
            )
            (source_root / "gotchas.md").write_text(
                "current gotchas",
                encoding="utf-8",
            )
            (target_root / "obsolete.md").write_text(
                "stale",
                encoding="utf-8",
            )

            sync_skills.synchronize_reference_trees(
                source_root,
                [target_root],
            )

            self.assertEqual(
                sorted(path.name for path in target_root.iterdir()),
                ["api-overview.md", "gotchas.md"],
            )


class SkillGuidanceTest(unittest.TestCase):
    def test_credentials_are_checked_without_printing_secrets(self) -> None:
        guidance = (
            sync_skills.PLUGIN_SKILLS_ROOT
            / "nimbusimage"
            / "SKILL.md"
        ).read_text(encoding="utf-8")

        self.assertNotIn("run `echo $", guidance)
        self.assertNotIn(
            "ask the user for their server URL and API key",
            guidance,
        )
        self.assertIn('test -n "${NI_API_KEY:-}"', guidance)
        self.assertIn('test -n "${NI_TOKEN:-}"', guidance)

    def test_annotation_guidance_uses_mutation_safe_pagination(self) -> None:
        guidance = (
            sync_skills.PLUGIN_SKILLS_ROOT
            / "annotations"
            / "SKILL.md"
        ).read_text(encoding="utf-8")
        api_reference = (
            sync_skills.PLUGIN_ROOT
            / "references"
            / "api-overview.md"
        ).read_text(encoding="utf-8")

        self.assertIn("mutation-safe", guidance)
        self.assertIn("ds.annotations.iter_all(", guidance)
        self.assertIn("after_id?", api_reference)
        self.assertIn("| `iter_all` |", api_reference)
        self.assertIn("| `update_many` |", api_reference)


class WorkflowValidationTest(unittest.TestCase):
    def test_documentation_requirements_trigger_sync_workflow(self) -> None:
        workflow = (
            sync_skills.REPO_ROOT
            / ".github"
            / "workflows"
            / "agent-skills.yaml"
        ).read_text(encoding="utf-8")

        self.assertEqual(workflow.count('- "README.md"'), 2)
        self.assertEqual(workflow.count('- "nimbusimage/README.md"'), 2)


if __name__ == "__main__":
    unittest.main()
