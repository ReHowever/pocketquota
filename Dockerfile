FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pocketquota /app/pocketquota
RUN useradd --uid 10001 --create-home pocketquota && mkdir /data && chown pocketquota:pocketquota /data
USER pocketquota
EXPOSE 18790
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import socket; s=socket.create_connection(('127.0.0.1',18790),2); s.close()"
CMD ["python", "-m", "pocketquota.server", "--host", "0.0.0.0", "--data", "/data"]
