# OpenGrokBot — 每个 bot 一台自己的电脑。
# 基底刻意选小：宿主磁盘/带宽有限，禁止用 mcr.microsoft.com/playwright（2GB+）。
FROM node:22-bookworm-slim

# 官方源在部分地区只有几十 KB/s。传镜像主机名即可换源，例如：
#   docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t opengrokbot/bot:dev docker/bot
ARG APT_MIRROR=""

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SHIM_PORT=7717

RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$f" ] && sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" "$f"; \
      done; \
    fi \
 && apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11-utils x11vnc \
      novnc websockify socat \
      ca-certificates fonts-liberation procps \
 && rm -rf /var/lib/apt/lists/*

COPY shim.mjs /opt/shim.mjs
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /workspace
EXPOSE 7717 9222 6080
CMD ["/opt/entrypoint.sh"]
