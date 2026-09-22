FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY light/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt \
    && pip uninstall -y hf-xet

COPY light/app.py .
COPY templates ./templates
COPY static ./static

EXPOSE 5000

CMD ["python", "app.py"]
