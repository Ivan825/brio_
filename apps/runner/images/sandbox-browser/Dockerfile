# The browser sandbox for computer use (ADAPTER_SPEC §2.7): the base image plus a virtual display (Xvfb), Chromium,
# xdotool for input and ImageMagick for screenshots. The model only plans actions; they run here, and the browser's
# traffic goes through the attempt's egress proxy, which lets it reach only the sites the task names.
ARG BASE
FROM ${BASE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb x11-utils xdotool imagemagick \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY brio-browser /usr/local/bin/brio-browser
RUN chmod 755 /usr/local/bin/brio-browser
USER 1000:1000
CMD ["sleep", "infinity"]
