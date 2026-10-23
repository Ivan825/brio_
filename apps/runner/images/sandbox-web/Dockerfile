# The web-audit sandbox (a11y and lighthouse checks): the base image plus Chromium, Lighthouse and axe-core at pinned
# versions checked on 23 Oct 2026. Audits run against the attempt's files served from inside the container, with no
# network (docs/DECISIONS.md D-58).
ARG BASE
FROM ${BASE}
USER root
ARG LIGHTHOUSE=13.5.0
ARG AXE=4.14.0
ARG PUPPETEER=25.13.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Puppeteer must not download its own browser: it drives the system Chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium
RUN mkdir -p /opt/brio-audit \
 && cd /opt/brio-audit \
 && npm init -y >/dev/null \
 && npm install --no-fund --no-audit "lighthouse@${LIGHTHOUSE}" "axe-core@${AXE}" "puppeteer-core@${PUPPETEER}" \
 && npm cache clean --force
COPY audit.mjs /opt/brio-audit/audit.mjs
RUN printf '#!/bin/sh\nexec node /opt/brio-audit/audit.mjs "$@"\n' > /usr/local/bin/brio-audit \
 && chmod 755 /usr/local/bin/brio-audit

USER 1000:1000
CMD ["sleep", "infinity"]
