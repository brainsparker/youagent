from youagent.knowledge.dedup import (
    compute_relevance,
    compute_novelty,
    is_duplicate_url,
)


class TestRelevanceScoring:
    def test_high_relevance_matching_terms(self):
        score = compute_relevance(
            text="EU AI Act regulation enforcement begins in 2026",
            queries=["AI regulation 2026", "EU AI Act enforcement"],
        )
        assert score > 0.5

    def test_low_relevance_unrelated(self):
        score = compute_relevance(
            text="New recipe for chocolate cake with vanilla frosting",
            queries=["AI regulation 2026"],
        )
        assert score < 0.3

    def test_relevance_from_path(self):
        score = compute_relevance(
            text="AI safety research shows promising results in regulation",
            queries=None,
            taxonomy_path="technology/ai/regulation",
        )
        assert score > 0.3


class TestNoveltyScoring:
    def test_novel_url(self):
        score = compute_novelty(
            url="https://example.com/new-article",
            existing_urls=set(),
        )
        assert score == 1.0

    def test_seen_url(self):
        score = compute_novelty(
            url="https://example.com/old-article",
            existing_urls={"https://example.com/old-article"},
        )
        assert score == 0.0

    def test_same_domain_reduces_novelty(self):
        score = compute_novelty(
            url="https://example.com/new-article",
            existing_urls={"https://example.com/other-article"},
        )
        assert 0.0 < score < 1.0


class TestDuplicateDetection:
    def test_exact_duplicate(self):
        assert is_duplicate_url(
            "https://example.com/article",
            {"https://example.com/article"},
        ) is True

    def test_not_duplicate(self):
        assert is_duplicate_url(
            "https://example.com/new",
            {"https://example.com/old"},
        ) is False
