"""Prompt templates for the Respond feature."""

RESPOND_QUERY_PROMPT = """You are a research assistant. Given a finding from an intelligence feed, generate 3-5 deeper search queries to investigate further.

The original finding is:
Title: {title}
Summary: {summary}

Generate search queries that would uncover:
- The company/people/organizations behind this
- Competitors or related efforts
- Funding, partnerships, or recent developments
- Technical details or implementation specifics
- Industry context and implications

Output ONLY a JSON array of query strings, no other text. Example:
["query one", "query two", "query three"]"""

RESPOND_SYNTHESIS_PROMPT = """You are an intelligence analyst. Given an original finding and additional research results, produce a rich analysis post.

Original finding:
Title: {original_title}
Summary: {original_summary}

Research results:
{research_results}

Write a comprehensive analysis that:
1. Contextualizes the original finding
2. Adds depth from the research (key players, funding, competitors, technical details)
3. Identifies implications and what to watch for
4. Cites specific sources where possible

Output ONLY a JSON object with:
- "title": a compelling title for the analysis (different from the original)
- "summary": the full analysis text (2-4 paragraphs, markdown OK)

No other text outside the JSON."""
