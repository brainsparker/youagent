import typer

config_app = typer.Typer(help="Configuration management")


@config_app.command("set")
def config_set(key: str, value: str):
    """Set a configuration value."""
    from youagent.config.settings import YouAgentSettings

    settings = YouAgentSettings.load()
    if key == "api-key":
        settings.youcom_api_key = value
        settings.save()
        typer.echo("API key saved.")
    else:
        typer.echo(f"Unknown config key: {key}", err=True)
        raise typer.Exit(1)


@config_app.command("show")
def config_show():
    """Show current configuration."""
    from youagent.config.settings import YouAgentSettings

    settings = YouAgentSettings.load()
    typer.echo(f"Home: {settings.home_dir}")
    masked = "****" + settings.youcom_api_key[-4:] if settings.youcom_api_key else "Not set"
    typer.echo(f"API Key: {masked}")
