FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY heavy/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt \
    && pip uninstall -y hf-xet

COPY heavy/app.py .
COPY templates ./templates
COPY static ./static

EXPOSE 5000

CMD ["python", "app.py"]
