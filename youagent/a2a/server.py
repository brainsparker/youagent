"""A2A FastAPI server — agent card, JSON-RPC endpoint, SSE streaming."""

import json
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from youagent.a2a.agent_card import generate_agent_card
from youagent.a2a.jsonrpc import JsonRpcDispatcher
from youagent.a2a.knowledge_handler import KnowledgeExchangeHandler
from youagent.a2a.models import (
    DataPart,
    JsonRpcError,
    JsonRpcResponse,
    Message,
    Task,
    TextPart,
)
from youagent.a2a.task_manager import TaskManager
from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.search.client import YouSearchClient


def create_a2a_app(
    agent: Agent,
    store: KnowledgeStore,
    search_client: Optional[YouSearchClient] = None,
    port: int = 8000,
) -> FastAPI:
    """Create a FastAPI app implementing the A2A protocol for a given agent."""
    app = FastAPI(title=f"YouAgent A2A - {agent.name}")

    endpoint = f"http://localhost:{port}/a2a"
    card = generate_agent_card(agent, endpoint=endpoint, port=port)
    task_manager = TaskManager()
    handler = KnowledgeExchangeHandler(
        task_manager=task_manager,
        store=store,
        search_client=search_client,
        agent_id=agent.id,
    )
    dispatcher = JsonRpcDispatcher()

    # --- JSON-RPC method handlers ---

    async def message_send(params: dict) -> dict:
        message_data = params.get("message", {})
        parts = []
        for p in message_data.get("parts", []):
            if p.get("type") == "text":
                parts.append(TextPart(text=p["text"]))
            elif p.get("type") == "data":
                parts.append(DataPart(data=p["data"]))

        message = Message(
            role=message_data.get("role", "user"),
            parts=parts,
            metadata=message_data.get("metadata", {}),
        )

        context_id = params.get("configuration", {}).get("contextId")
        task = await task_manager.create_task(message, context_id=context_id)
        result_task = await handler.handle_message(task, message)
        return _task_to_dict(result_task)

    async def tasks_get(params: dict) -> dict:
        task_id = params.get("id")
        if not task_id:
            raise ValueError("Task ID is required")
        task = await task_manager.get_task(task_id)
        if not task:
            raise TaskNotFoundError(task_id)
        return _task_to_dict(task)

    async def tasks_cancel(params: dict) -> dict:
        task_id = params.get("id")
        if not task_id:
            raise ValueError("Task ID is required")
        success = await task_manager.cancel_task(task_id)
        if not success:
            task = await task_manager.get_task(task_id)
            if not task:
                raise TaskNotFoundError(task_id)
            raise TaskNotCancelableError(task_id)
        task = await task_manager.get_task(task_id)
        return _task_to_dict(task)

    dispatcher.register("message/send", message_send)
    dispatcher.register("tasks/get", tasks_get)
    dispatcher.register("tasks/cancel", tasks_cancel)

    # --- Routes ---

    @app.get("/.well-known/agent.json")
    async def get_agent_card():
        return JSONResponse(
            content=card.model_dump(by_alias=True),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    @app.post("/a2a")
    async def handle_jsonrpc(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                content=JsonRpcResponse(
                    error=JsonRpcError(code=-32700, message="Parse error")
                ).model_dump(),
                headers={"a2a-version": "0.3"},
            )

        if isinstance(body, list):
            responses = await dispatcher.dispatch_batch(body)
            return JSONResponse(
                content=[r.model_dump() for r in responses],
                headers={"a2a-version": "0.3"},
            )

        response = await dispatcher.dispatch(body)
        return JSONResponse(
            content=response.model_dump(),
            headers={"a2a-version": "0.3"},
        )

    @app.post("/a2a/stream")
    async def handle_stream(request: Request):
        """SSE streaming endpoint for message/send/stream."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                content=JsonRpcResponse(
                    error=JsonRpcError(code=-32700, message="Parse error")
                ).model_dump(),
            )

        params = body.get("params", {})
        request_id = body.get("id")

        async def event_generator():
            # Create task
            message_data = params.get("message", {})
            parts = []
            for p in message_data.get("parts", []):
                if p.get("type") == "text":
                    parts.append(TextPart(text=p["text"]))
                elif p.get("type") == "data":
                    parts.append(DataPart(data=p["data"]))

            message = Message(
                role=message_data.get("role", "user"),
                parts=parts,
                metadata=message_data.get("metadata", {}),
            )

            task = await task_manager.create_task(message)

            # Send working status
            yield json.dumps(JsonRpcResponse(
                id=request_id,
                result={"type": "statusUpdate", "task": _task_to_dict(task)},
            ).model_dump())

            # Process
            result_task = await handler.handle_message(task, message)

            # Send final result
            yield json.dumps(JsonRpcResponse(
                id=request_id,
                result={"type": "task", "task": _task_to_dict(result_task)},
            ).model_dump())

        return EventSourceResponse(event_generator())

    return app


def _task_to_dict(task: Task) -> dict:
    """Convert task to A2A-compatible dict."""
    return {
        "id": task.id,
        "contextId": task.context_id,
        "status": {
            "state": task.status.state.value,
            "message": task.status.message,
            "timestamp": task.status.timestamp.isoformat(),
        },
        "artifacts": [
            {
                "id": a.id,
                "parts": [p.model_dump() for p in a.parts],
                "metadata": a.metadata,
            }
            for a in task.artifacts
        ],
        "history": [
            {
                "role": m.role,
                "parts": [p.model_dump() for p in m.parts],
                "metadata": m.metadata,
            }
            for m in task.history
        ],
        "metadata": task.metadata,
    }


class TaskNotFoundError(Exception):
    def __init__(self, task_id: str):
        super().__init__(f"Task not found: {task_id}")


class TaskNotCancelableError(Exception):
    def __init__(self, task_id: str):
        super().__init__(f"Task not cancelable: {task_id}")
