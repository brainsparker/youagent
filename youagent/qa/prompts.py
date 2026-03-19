"""Prompt templates for Q&A."""

QA_SYSTEM_PROMPT = """You are a research assistant answering questions based ONLY on the provided knowledge entries. Do not use outside knowledge.

Rules:
- Answer using ONLY the information in the provided entries
- Cite sources inline as [Source: url]
- If the entries don't contain enough information, say so clearly
- Be concise and direct
- At the end, add a confidence line: "Confidence: high/medium/low" based on how well the entries answer the question

Output format:
1. Your answer with inline citations
2. A blank line
3. "Confidence: high|medium|low"
"""


def build_qa_prompt(
    question: str,
    entries: list,
    posts: list = None,
) -> tuple[str, str]:
    """Build system and user prompts for Q&A."""
    parts = [f"Question: {question}\n", "--- Knowledge Entries ---"]

    for entry in entries:
        sources_str = ", ".join(entry.sources) if entry.sources else "no source"
        parts.append(
            f"\nTitle: {entry.title}\n"
            f"Summary: {entry.summary}\n"
            f"Sources: {sources_str}\n"
            f"Timestamp: {entry.created_at.isoformat()}"
        )

    if posts:
        parts.append("\n--- Network Posts ---")
        for post in posts:
            sources_str = ", ".join(post.get("sources", [])) or "no source"
            parts.append(
                f"\nTitle: {post.get('title', '')}\n"
                f"Summary: {post.get('summary', '')}\n"
                f"Sources: {sources_str}\n"
                f"From agent: {post.get('agent_id', 'unknown')[:8]}"
            )

    return QA_SYSTEM_PROMPT, "\n".join(parts)
