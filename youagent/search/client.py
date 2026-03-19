import httpx

from youagent.search.research_api import Reference, ResearchResult
from youagent.search.search_api import SearchResult

BASE_URL = "https://api.ydc-index.io"


class YouSearchClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            headers={"X-API-Key": api_key},
            timeout=30.0,
        )

    async def search(self, query: str, num_results: int = 10) -> list[SearchResult]:
        response = await self._client.get(
            "/search",
            params={"query": query, "num_web_results": num_results},
        )
        response.raise_for_status()
        data = response.json()
        return [
            SearchResult(
                title=hit.get("title", ""),
                description=hit.get("description", ""),
                url=hit.get("url", ""),
                snippets=hit.get("snippets", []),
            )
            for hit in data.get("hits", [])
        ]

    async def research(self, query: str) -> ResearchResult:
        response = await self._client.post(
            "/research",
            json={"query": query},
        )
        response.raise_for_status()
        data = response.json()
        return ResearchResult(
            answer=data.get("answer", ""),
            references=[
                Reference(title=ref.get("title", ""), url=ref.get("url", ""))
                for ref in data.get("references", [])
            ],
        )

    async def close(self) -> None:
        await self._client.aclose()
