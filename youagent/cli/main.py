import typer

from youagent import __version__

app = typer.Typer(name="youagent", help="YouAgent - Your personal AI agent on the You.com network")


def version_callback(value: bool):
    if value:
        typer.echo(f"youagent {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(False, "--version", callback=version_callback, is_eager=True),
):
    pass
