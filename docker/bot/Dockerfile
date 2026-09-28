# OpenGrokBot — 每个 bot 一台自己的电脑。
# 基底刻意选小：宿主磁盘/带宽有限，禁止用 mcr.microsoft.com/playwright（2GB+）。
FROM node:22-bookworm-slim

# 官方源在部分地区只有几十 KB/s。传镜像主机名即可换源，例如：
#   docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t opengrokbot/bot:dev docker/bot
ARG APT_MIRROR=""

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LANG=C.UTF-8 \
    SHIM_PORT=7717

# 字体：wqy-microhei 让中文页面不再是一排方块（只有几 MB，比 noto-cjk 小一个量级），noto-color-emoji 管 emoji。
# tzdata：网关把自己的时区传进来（TZ），bot 在 shell 里看到的时间和 routine 的时间一致。
# Acquire::Retries：镜像站偶尔 503 / 超时，大包（chromium）重试几次通常就过了。
RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$f" ] && sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" "$f"; \
      done; \
    fi \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      chromium \
      xvfb x11-utils x11vnc \
      novnc websockify socat \
      ca-certificates procps tzdata \
      fonts-liberation fonts-wqy-microhei fonts-noto-color-emoji fontconfig \
 && rm -rf /var/lib/apt/lists/*

COPY shim.mjs /opt/shim.mjs
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /workspace
EXPOSE 7717 9222 6080
CMD ["/opt/entrypoint.sh"]
