from pathlib import Path
from typing import Optional

import yaml

from youagent.taxonomy.tree import TaxonomyTree

BASE_TAXONOMY = Path(__file__).parent / "base_taxonomy.yaml"


def load_taxonomy(custom_path: Optional[Path] = None) -> TaxonomyTree:
    with open(BASE_TAXONOMY) as f:
        base_data = yaml.safe_load(f)

    tree = TaxonomyTree.from_dict(base_data)

    if custom_path and custom_path.exists():
        with open(custom_path) as f:
            custom_data = yaml.safe_load(f)
        if custom_data:
            custom_tree = TaxonomyTree.from_dict(custom_data)
            tree.merge(custom_tree)

    return tree
