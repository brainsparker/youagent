import pytest
from pathlib import Path

from youagent.taxonomy.tree import TaxonomyTree
from youagent.taxonomy.loader import load_taxonomy


class TestTaxonomyTree:
    @pytest.fixture
    def tree(self) -> TaxonomyTree:
        return TaxonomyTree.from_dict({
            "technology": {
                "ai": ["regulation", "safety", "agents"],
                "quantum": ["computing"],
            },
            "business": {
                "startups": ["funding", "exits"],
            },
        })

    def test_contains_valid_path(self, tree: TaxonomyTree):
        assert tree.contains("technology/ai/regulation")
        assert tree.contains("technology/ai")
        assert tree.contains("technology")

    def test_rejects_invalid_path(self, tree: TaxonomyTree):
        assert not tree.contains("technology/blockchain")
        assert not tree.contains("sports")

    def test_get_children(self, tree: TaxonomyTree):
        children = tree.get_children("technology/ai")
        assert set(children) == {"regulation", "safety", "agents"}

    def test_get_children_of_root(self, tree: TaxonomyTree):
        children = tree.get_children("")
        assert set(children) == {"technology", "business"}

    def test_get_ancestors(self, tree: TaxonomyTree):
        ancestors = tree.get_ancestors("technology/ai/regulation")
        assert ancestors == ["technology", "technology/ai"]

    def test_search(self, tree: TaxonomyTree):
        results = tree.search("fund")
        assert "business/startups/funding" in results

    def test_search_no_results(self, tree: TaxonomyTree):
        results = tree.search("xyz123")
        assert results == []

    def test_all_paths(self, tree: TaxonomyTree):
        paths = tree.all_leaf_paths()
        assert "technology/ai/regulation" in paths
        assert "business/startups/funding" in paths

    def test_match_by_prefix(self, tree: TaxonomyTree):
        matches = tree.match_prefix("technology/ai")
        assert "technology/ai/regulation" in matches
        assert "technology/ai/safety" in matches
        assert "business/startups/funding" not in matches


class TestTaxonomyLoader:
    def test_load_base_taxonomy(self):
        tree = load_taxonomy()
        assert tree.contains("technology/ai/regulation")
        assert tree.contains("business/startups/funding")

    def test_load_with_custom_extensions(self, tmp_path: Path):
        custom = tmp_path / "custom.yaml"
        custom.write_text("technology:\n  ai:\n    - robotics\n    - ethics\n")
        tree = load_taxonomy(custom_path=custom)
        assert tree.contains("technology/ai/robotics")
        assert tree.contains("technology/ai/regulation")
