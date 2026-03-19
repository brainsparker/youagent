"""Provider-agnostic async LLM client using raw httpx."""

import os
from enum import Enum
from typing import Optional

import httpx


class LLMProvider(str, Enum):
    CLAUDE = "claude"
    OPENAI = "openai"


DEFAULT_MODELS = {
    LLMProvider.CLAUDE: "claude-sonnet-4-20250514",
    LLMProvider.OPENAI: "gpt-4o",
}

API_URLS = {
    LLMProvider.CLAUDE: "https://api.anthropic.com/v1/messages",
    LLMProvider.OPENAI: "https://api.openai.com/v1/chat/completions",
}


def create_llm_client(settings=None) -> Optional["LLMClient"]:
    """Factory function to create an LLMClient from settings and/or environment.

    Checks settings first, then falls back to environment variables.
    Returns None if no credentials are found.
    """
    provider_str = getattr(settings, "llm_provider", None) if settings else None
    api_key = getattr(settings, "llm_api_key", None) if settings else None
    model = getattr(settings, "llm_model", None) if settings else None

    # Fall back to environment variables
    if not api_key:
        if provider_str == "openai":
            api_key = os.environ.get("OPENAI_API_KEY")
        else:
            api_key = os.environ.get("ANTHROPIC_API_KEY")

    if not provider_str:
        if os.environ.get("ANTHROPIC_API_KEY"):
            provider_str = "claude"
            api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        elif os.environ.get("OPENAI_API_KEY"):
            provider_str = "openai"
            api_key = api_key or os.environ.get("OPENAI_API_KEY")

    if not api_key or not provider_str:
        return None

    provider = LLMProvider(provider_str)
    return LLMClient(provider=provider, api_key=api_key, model=model)


class LLMClient:
    def __init__(
        self,
        provider: LLMProvider,
        api_key: str,
        model: Optional[str] = None,
    ) -> None:
        self.provider = provider
        self.api_key = api_key
        self.model = model or DEFAULT_MODELS[provider]
        self._http = httpx.AsyncClient(timeout=120.0)

    async def complete(self, system_prompt: str, user_prompt: str) -> str:
        if self.provider == LLMProvider.CLAUDE:
            return await self._complete_claude(system_prompt, user_prompt)
        return await self._complete_openai(system_prompt, user_prompt)

    async def _complete_claude(self, system_prompt: str, user_prompt: str) -> str:
        resp = await self._http.post(
            API_URLS[LLMProvider.CLAUDE],
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["content"][0]["text"]

    async def _complete_openai(self, system_prompt: str, user_prompt: str) -> str:
        resp = await self._http.post(
            API_URLS[LLMProvider.OPENAI],
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]

    async def close(self) -> None:
        await self._http.aclose()
