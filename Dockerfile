FROM node:22-slim
ARG SINGBOX_VERSION=1.11.4
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Xray-core (آخرین نسخه)
RUN curl -fsSL -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip \
 && unzip -o /tmp/xray.zip xray -d /usr/local/bin && chmod +x /usr/local/bin/xray && rm /tmp/xray.zip || echo 'xray download failed'
# sing-box
RUN curl -fsSL -o /tmp/sb.tgz https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-amd64.tar.gz \
 && tar -xzf /tmp/sb.tgz -C /tmp && cp /tmp/sing-box-*/sing-box /usr/local/bin/ && chmod +x /usr/local/bin/sing-box && rm -rf /tmp/sb.tgz /tmp/sing-box-* || echo 'sing-box download failed'
WORKDIR /app
COPY . .
ENV DATA_DIR=/data
CMD ["node","server.js"]
