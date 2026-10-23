# The per-sandbox egress proxy (apps/runner/images/egress-proxy/proxy.mjs).
FROM node:22.22.0-alpine3.22
COPY proxy.mjs /proxy/proxy.mjs
USER node
EXPOSE 3128
ENTRYPOINT ["node", "/proxy/proxy.mjs"]
