FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY app/ app/
COPY static/ static/
COPY templates/ templates/
COPY run.py .

RUN mkdir -p instance presets

EXPOSE 5030

CMD ["gunicorn", "--bind", "0.0.0.0:5030", "--workers", "2", "--threads", "4", "--worker-class", "gthread", "run:app"]
