FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ARG DEBIAN_SNAPSHOT=20261015T000000Z
RUN printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libfontconfig1 libfreetype6 fonts-dejavu-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/regional-worker
COPY install_moli.py ./
RUN python install_moli.py --destination /opt/moli && /opt/moli/moli --version \
    && groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp/worker worker \
    && mkdir -p /var/lib/regional-worker \
    && chown 10001:10001 /var/lib/regional-worker \
    && chmod 700 /var/lib/regional-worker
COPY worker.py page_parser.py platform_limits.py network_guard.py chromium_fetch.py THIRD_PARTY.md PLAYWRIGHT-LICENSE ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MOLI_BIN=/opt/moli/moli SPOOL_DIR=/var/lib/regional-worker JOBS_DIR=/tmp/regional-jobs FETCH_ENGINE=moli
USER 10001:10001
ENTRYPOINT ["python", "worker.py"]
CMD ["poll"]
