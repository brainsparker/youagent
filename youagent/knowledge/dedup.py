from typing import Optional
from urllib.parse import urlparse


def compute_relevance(
    text: str,
    queries: Optional[list[str]] = None,
    taxonomy_path: Optional[str] = None,
) -> float:
    text_lower = text.lower()
    terms: set[str] = set()

    if queries:
        for query in queries:
            terms.update(query.lower().split())
    elif taxonomy_path:
        terms.update(taxonomy_path.replace("/", " ").lower().split())

    if not terms:
        return 0.0

    text_words = set(text_lower.split())
    matches = terms & text_words
    return len(matches) / len(terms) if terms else 0.0


def compute_novelty(url: str, existing_urls: set[str]) -> float:
    if url in existing_urls:
        return 0.0

    parsed = urlparse(url)
    domain = parsed.netloc

    same_domain_count = sum(
        1 for u in existing_urls if urlparse(u).netloc == domain
    )

    if same_domain_count == 0:
        return 1.0

    return max(0.1, 1.0 - (same_domain_count * 0.2))


def is_duplicate_url(url: str, existing_urls: set[str]) -> bool:
    return url in existing_urls
