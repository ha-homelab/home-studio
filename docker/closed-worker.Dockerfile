# Reference toolchain: the workflow pulls this immutable public image directly.
# Mount the reviewed entrypoint read-only; never COPY private inputs into images.
FROM ghcr.io/home-assistant/home-assistant@sha256:33afb0659d786213264c2211f8d91c5fe87461c56eba6a3a546eb05fc71e89f4
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["python3", "/tool/closed_worker.py"]
