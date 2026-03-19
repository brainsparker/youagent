import typer
from rich.console import Console
from rich.tree import Tree as RichTree

from youagent.taxonomy.loader import load_taxonomy

taxonomy_app = typer.Typer(help="Taxonomy operations")
console = Console()


@taxonomy_app.command("show")
def show():
    """Display the full taxonomy tree."""
    taxonomy = load_taxonomy()

    def build_tree(rich_node, path: str):
        children = taxonomy.get_children(path)
        for child in children:
            child_path = f"{path}/{child}" if path else child
            sub = rich_node.add(f"[cyan]{child}[/cyan]")
            build_tree(sub, child_path)

    tree = RichTree("[bold]YouAgent Taxonomy[/bold]")
    build_tree(tree, "")
    console.print(tree)


@taxonomy_app.command("search")
def search(query: str):
    """Search the taxonomy for matching paths."""
    taxonomy = load_taxonomy()
    results = taxonomy.search(query)
    if not results:
        typer.echo(f"No taxonomy paths matching '{query}'.")
        return
    for path in results:
        console.print(f"  [cyan]{path}[/cyan]")
