from pydantic import BaseModel


class Reference(BaseModel):
    title: str
    url: str


class ResearchResult(BaseModel):
    answer: str
    references: list[Reference] = []
