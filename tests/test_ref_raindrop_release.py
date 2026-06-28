import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin" / "ref-raindrop"


class RefRaindropReleaseTest(unittest.TestCase):
    def test_plugin_files_exist(self):
        for name in ["manifest.json", "main.js", "styles.css", "versions.json"]:
            self.assertTrue((PLUGIN / name).is_file(), name)
        for name in ["manifest.json", "versions.json"]:
            self.assertTrue((ROOT / name).is_file(), name)
        self.assertTrue((ROOT / "LICENSE").is_file())
        self.assertTrue((ROOT / "README.md").is_file())
        self.assertTrue((ROOT / "README.ja.md").is_file())
        self.assertTrue((ROOT / ".github" / "workflows" / "release.yml").is_file())
        self.assertTrue((ROOT / "docs" / "ref-raindrop.ja.md").is_file())

    def test_manifest_identity(self):
        manifest = json.loads((PLUGIN / "manifest.json").read_text())
        self.assertEqual(manifest["id"], "ref-raindrop")
        self.assertEqual(manifest["name"], "RefRaindrop")
        self.assertEqual(manifest["author"], "oikeya")
        self.assertTrue(manifest["isDesktopOnly"])

    def test_versions_matches_manifest(self):
        manifest = json.loads((PLUGIN / "manifest.json").read_text())
        versions = json.loads((PLUGIN / "versions.json").read_text())
        self.assertEqual(versions[manifest["version"]], manifest["minAppVersion"])

    def test_root_release_metadata_matches_plugin_metadata(self):
        self.assertEqual(
            json.loads((ROOT / "manifest.json").read_text()),
            json.loads((PLUGIN / "manifest.json").read_text()),
        )
        self.assertEqual(
            json.loads((ROOT / "versions.json").read_text()),
            json.loads((PLUGIN / "versions.json").read_text()),
        )

    def test_main_js_balanced_delimiters(self):
        text = (PLUGIN / "main.js").read_text()
        self.assertEqual(text.count("{"), text.count("}"))
        self.assertEqual(text.count("("), text.count(")"))
        self.assertEqual(text.count("["), text.count("]"))

    def test_no_direct_filesystem_access(self):
        text = (PLUGIN / "main.js").read_text()
        forbidden = ['require("fs")', 'require("os")', 'require("path")', "fs.", "os.homedir", "path.join"]
        for word in forbidden:
            self.assertNotIn(word, text)

    def test_old_agent_branding_is_not_in_release_files(self):
        paths = [
            ROOT / "README.md",
            ROOT / "docs" / "ref-raindrop.md",
            ROOT / "manifest.json",
            ROOT / "versions.json",
            PLUGIN / "manifest.json",
            PLUGIN / "versions.json",
            PLUGIN / "main.js",
            PLUGIN / "styles.css",
        ]
        forbidden = ["bookmark-agent", "bookmark_agent", "ai-bookmark-indexer", "AI Bookmark Indexer"]
        for path in paths:
            text = path.read_text()
            for word in forbidden:
                self.assertNotIn(word, text, f"{word} remains in {path.relative_to(ROOT)}")


if __name__ == "__main__":
    unittest.main()
