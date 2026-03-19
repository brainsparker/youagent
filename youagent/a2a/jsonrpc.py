"""JSON-RPC 2.0 dispatcher for A2A protocol."""

from typing import Any, Callable, Coroutine

from youagent.a2a.models import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    JsonRpcError,
    JsonRpcResponse,
)


class JsonRpcDispatcher:
    def __init__(self) -> None:
        self._methods: dict[str, Callable[..., Coroutine[Any, Any, Any]]] = {}

    def register(self, method_name: str, handler: Callable[..., Coroutine[Any, Any, Any]]) -> None:
        self._methods[method_name] = handler

    async def dispatch(self, raw_request: dict) -> JsonRpcResponse:
        # Validate JSON-RPC format
        if not isinstance(raw_request, dict):
            return JsonRpcResponse(
                error=JsonRpcError(code=INVALID_REQUEST, message="Request must be a JSON object"),
            )

        if raw_request.get("jsonrpc") != "2.0":
            return JsonRpcResponse(
                id=raw_request.get("id"),
                error=JsonRpcError(code=INVALID_REQUEST, message="jsonrpc must be '2.0'"),
            )

        method = raw_request.get("method")
        if not method or not isinstance(method, str):
            return JsonRpcResponse(
                id=raw_request.get("id"),
                error=JsonRpcError(code=INVALID_REQUEST, message="method is required"),
            )

        request_id = raw_request.get("id")
        params = raw_request.get("params", {})

        handler = self._methods.get(method)
        if not handler:
            return JsonRpcResponse(
                id=request_id,
                error=JsonRpcError(code=METHOD_NOT_FOUND, message=f"Method not found: {method}"),
            )

        try:
            result = await handler(params)
            return JsonRpcResponse(id=request_id, result=result)
        except Exception as e:
            return JsonRpcResponse(
                id=request_id,
                error=JsonRpcError(code=INTERNAL_ERROR, message=str(e)),
            )

    async def dispatch_batch(self, raw_requests: list[dict]) -> list[JsonRpcResponse]:
        return [await self.dispatch(req) for req in raw_requests]
