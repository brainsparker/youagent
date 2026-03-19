from pydantic import BaseModel


class SearchResult(BaseModel):
    title: str
    description: str
    url: str
    snippets: list[str] = []
