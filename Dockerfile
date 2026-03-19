FROM python:3.11-slim

WORKDIR /app

# Install deps
COPY pyproject.toml README.md ./
COPY youagent/ youagent/
RUN pip install --no-cache-dir .

# Create data directory
RUN mkdir -p /data/.youagent/data /data/.youagent/agents /data/.youagent/taxonomy

ENV YOUAGENT_HOME=/data/.youagent
ENV YOUAGENT_HOSTED=true
ENV YOUAGENT_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import httpx; httpx.get('http://localhost:8080/health').raise_for_status()" || exit 1

CMD ["python", "-m", "uvicorn", "youagent.hosted.run:app", "--host", "0.0.0.0", "--port", "8080"]
