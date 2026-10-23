# The coding-CLI sandbox: the base image plus the official headless CLIs, at pinned versions checked on 23 Oct 2026
# (docs/DECISIONS.md D-36). Installed as root at build time; they run as the non-root sandbox user, with no stored
# logins: every key arrives per run through the environment (CLAUDE.md rule 1).
ARG BASE
FROM ${BASE}
USER root
ARG TARGETARCH
ARG CLAUDE_CODE=2.1.309
ARG CODEX=0.164.0
ARG OPENCODE=1.19.4
ARG CURSOR=2026.10.22-27dcf5f
ARG AGY=1.4.6-4884751325200384
ARG GOOSE=1.55.0
ARG AIDER=0.86.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends bzip2 libxcb1 libgomp1 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/*

# npm CLIs (their postinstall picks the native binary for this architecture, so scripts stay enabled)
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE}" "@openai/codex@${CODEX}" "opencode-ai@${OPENCODE}" \
 && npm cache clean --force

# Cursor Agent CLI and Antigravity CLI: pinned release tarballs
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      arm64) cursor=arm64; agy=linux-arm/cli_linux_arm64; goose=aarch64 ;; \
      amd64) cursor=x64;   agy=linux-x64/cli_linux_x64;   goose=x86_64 ;; \
      *) echo "unsupported arch"; exit 1 ;; \
    esac; \
    mkdir -p /opt/cursor-agent; \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR}/linux/${cursor}/agent-cli-package.tar.gz" | tar -xz -C /opt/cursor-agent; \
    ln -s /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent; \
    curl -fsSL "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY}/${agy}.tar.gz" | tar -xz -C /usr/local/bin; \
    mv /usr/local/bin/antigravity /usr/local/bin/agy; \
    curl -fsSL "https://github.com/aaif-goose/goose/releases/download/v${GOOSE}/goose-${goose}-unknown-linux-gnu.tar.bz2" | tar -xj -C /usr/local/bin; \
    chmod 0755 /usr/local/bin/agy /usr/local/bin/goose

# Aider in its own virtualenv (Python 3.11 from bookworm; aider supports 3.10–3.12)
RUN python3 -m venv /opt/aider \
 && /opt/aider/bin/pip install --no-cache-dir "aider-chat==${AIDER}" \
 && ln -s /opt/aider/bin/aider /usr/local/bin/aider

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_CLAUDE_CODE=1 \
    GOOSE_DISABLE_KEYRING=1 \
    GOOSE_TELEMETRY_ENABLED=false \
    AIDER_ANALYTICS_DISABLE=1 \
    AIDER_CHECK_UPDATE=false \
    LITELLM_LOCAL_MODEL_COST_MAP=True
USER 1000:1000
