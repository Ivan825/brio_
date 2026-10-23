# The base sandbox: what every attempt's container starts from. Non-root, git, Node, Python; no credentials, no
# Docker. CLI images (images/sandbox-cli) add the official coding CLIs on top.
FROM node:22.22.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 python3-venv ripgrep procps \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 && mkdir -p /work /home/brio && chmod 1777 /home/brio
ENV HOME=/home/brio \
    CI=true \
    NO_COLOR=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /work
USER 1000:1000
CMD ["sleep", "infinity"]
