from __future__ import annotations


class TaxonomyTree:
    def __init__(self) -> None:
        self._nodes: dict[str, set[str]] = {}

    @classmethod
    def from_dict(cls, data: dict) -> TaxonomyTree:
        tree = cls()
        tree._build("", data)
        return tree

    def _build(self, prefix: str, data: dict | list | str) -> None:
        if isinstance(data, dict):
            for key, value in data.items():
                path = f"{prefix}/{key}" if prefix else key
                parent = prefix or ""
                if parent not in self._nodes:
                    self._nodes[parent] = set()
                self._nodes[parent].add(key)
                if path not in self._nodes:
                    self._nodes[path] = set()
                self._build(path, value)
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, str):
                    if prefix not in self._nodes:
                        self._nodes[prefix] = set()
                    self._nodes[prefix].add(item)
                    leaf_path = f"{prefix}/{item}"
                    if leaf_path not in self._nodes:
                        self._nodes[leaf_path] = set()
                else:
                    self._build(prefix, item)

    def contains(self, path: str) -> bool:
        return path in self._nodes

    def get_children(self, path: str) -> list[str]:
        return sorted(self._nodes.get(path, set()))

    def get_ancestors(self, path: str) -> list[str]:
        parts = path.split("/")
        ancestors = []
        for i in range(1, len(parts)):
            ancestors.append("/".join(parts[:i]))
        return ancestors

    def search(self, query: str) -> list[str]:
        query_lower = query.lower()
        return sorted(
            path for path in self._nodes if path and query_lower in path.lower()
        )

    def all_leaf_paths(self) -> list[str]:
        return sorted(
            path for path, children in self._nodes.items() if path and not children
        )

    def match_prefix(self, prefix: str) -> list[str]:
        return sorted(
            path for path in self._nodes
            if path.startswith(prefix + "/") or path == prefix
        )

    def merge(self, other: TaxonomyTree) -> None:
        for path, children in other._nodes.items():
            if path in self._nodes:
                self._nodes[path].update(children)
            else:
                self._nodes[path] = set(children)
