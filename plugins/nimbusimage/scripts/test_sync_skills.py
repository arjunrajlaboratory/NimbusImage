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


if __name__ == "__main__":
    unittest.main()
