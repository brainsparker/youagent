"""A2A client for connecting to remote agents."""

import json
from typing import AsyncGenerator

import httpx

from youagent.a2a.models import (
    A2AAgentCard,
    JsonRpcRequest,
    Message,
)


class A2AClient:
    def __init__(self, timeout: float = 30.0) -> None:
        self._client = httpx.AsyncClient(timeout=timeout)

    async def discover(self, base_url: str) -> A2AAgentCard:
        """Fetch agent card from a remote agent."""
        url = f"{base_url.rstrip('/')}/.well-known/agent.json"
        response = await self._client.get(url)
        response.raise_for_status()
        return A2AAgentCard.model_validate(response.json())

    async def send_message(self, endpoint: str, message: Message) -> dict:
        """Send a message to a remote agent via JSON-RPC."""
        request = JsonRpcRequest(
            method="message/send",
            params={
                "message": {
                    "role": message.role,
                    "parts": [p.model_dump() for p in message.parts],
                    "metadata": message.metadata,
                },
            },
            id=1,
        )
        response = await self._client.post(
            endpoint,
            json=request.model_dump(),
        )
        response.raise_for_status()
        data = response.json()
        if data.get("error"):
            raise A2AError(data["error"]["code"], data["error"]["message"])
        return data.get("result", {})

    async def send_message_stream(
        self, endpoint: str, message: Message
    ) -> AsyncGenerator[dict, None]:
        """Send a message with SSE streaming response."""
        stream_endpoint = endpoint.rstrip("/") + "/stream"
        request_data = {
            "jsonrpc": "2.0",
            "method": "message/send/stream",
            "params": {
                "message": {
                    "role": message.role,
                    "parts": [p.model_dump() for p in message.parts],
                    "metadata": message.metadata,
                },
            },
            "id": 1,
        }
        async with self._client.stream(
            "POST", stream_endpoint, json=request_data
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data = json.loads(line[6:])
                    yield data

    async def get_task(self, endpoint: str, task_id: str) -> dict:
        """Get task status from a remote agent."""
        request = JsonRpcRequest(
            method="tasks/get",
            params={"id": task_id},
            id=1,
        )
        response = await self._client.post(endpoint, json=request.model_dump())
        response.raise_for_status()
        data = response.json()
        if data.get("error"):
            raise A2AError(data["error"]["code"], data["error"]["message"])
        return data.get("result", {})

    async def cancel_task(self, endpoint: str, task_id: str) -> dict:
        """Cancel a task on a remote agent."""
        request = JsonRpcRequest(
            method="tasks/cancel",
            params={"id": task_id},
            id=1,
        )
        response = await self._client.post(endpoint, json=request.model_dump())
        response.raise_for_status()
        data = response.json()
        if data.get("error"):
            raise A2AError(data["error"]["code"], data["error"]["message"])
        return data.get("result", {})

    async def close(self) -> None:
        await self._client.aclose()


class A2AError(Exception):
    def __init__(self, code: int, message: str):
        self.code = code
        self.a2a_message = message
        super().__init__(f"A2A Error {code}: {message}")
