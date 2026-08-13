#!/bin/bash
# bot 容器启动序列：X 显示器 → VNC → 有头 Chromium（CDP）→ shim（前台）
set -euo pipefail

export DISPLAY=:99
mkdir -p /workspace/.browser /workspace/files

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
for _ in $(seq 1 60); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 0.25
done
xdpyinfo -display :99 >/dev/null 2>&1 || { echo "[entrypoint] Xvfb failed to start" >&2; exit 1; }

x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 -bg
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# Chromium 会无视 --remote-debugging-address，始终只监听 127.0.0.1，
# 所以让它开在内部的 9223，再用 socat 把 9222 中继出去给宿主连。
chromium \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --remote-debugging-port=9223 \
  --user-data-dir=/workspace/.browser \
  --window-position=0,0 --window-size=1280,800 \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  about:blank &

socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9223 &

exec node /opt/shim.mjs
