import pytest
import httpx
import respx

from youagent.search.client import YouSearchClient


class TestSearchAPI:
    @pytest.fixture
    def client(self):
        return YouSearchClient(api_key="test-key")

    @respx.mock
    async def test_search(self, client: YouSearchClient):
        respx.get("https://api.ydc-index.io/search").mock(
            return_value=httpx.Response(200, json={
                "hits": [
                    {
                        "title": "AI Regulation News",
                        "description": "The EU passed new rules.",
                        "url": "https://example.com/ai-reg",
                        "snippets": ["EU AI Act enforcement begins."],
                    }
                ]
            })
        )
        results = await client.search("AI regulation 2026")
        assert len(results) == 1
        assert results[0].title == "AI Regulation News"
        assert results[0].url == "https://example.com/ai-reg"

    @respx.mock
    async def test_search_empty(self, client: YouSearchClient):
        respx.get("https://api.ydc-index.io/search").mock(
            return_value=httpx.Response(200, json={"hits": []})
        )
        results = await client.search("xyznonexistent")
        assert results == []

    @respx.mock
    async def test_search_api_error(self, client: YouSearchClient):
        respx.get("https://api.ydc-index.io/search").mock(
            return_value=httpx.Response(500)
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.search("test query")


class TestResearchAPI:
    @pytest.fixture
    def client(self):
        return YouSearchClient(api_key="test-key")

    @respx.mock
    async def test_research(self, client: YouSearchClient):
        respx.post("https://api.ydc-index.io/research").mock(
            return_value=httpx.Response(200, json={
                "answer": "The EU AI Act is being enforced starting 2026.",
                "references": [
                    {"title": "EU AI Act", "url": "https://example.com/eu-ai-act"}
                ],
            })
        )
        result = await client.research("What's happening with AI regulation?")
        assert "EU AI Act" in result.answer
        assert len(result.references) == 1

    @respx.mock
    async def test_research_api_error(self, client: YouSearchClient):
        respx.post("https://api.ydc-index.io/research").mock(
            return_value=httpx.Response(429)
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.research("test")
