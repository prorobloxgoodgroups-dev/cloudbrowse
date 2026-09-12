# CloudBrowse — runs a real Chromium and streams it over WebSocket.
# Built for Hugging Face Spaces (Docker SDK, app_port 7860) but this image runs
# anywhere Docker does: `docker build -t cloudbrowse . && docker run -p 7860:7860 cloudbrowse`
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates dumb-init \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      fonts-tlwg-loma-otf fonts-noto-cjk \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 libxshmfence1 libgbm1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=7860

# Hugging Face Spaces expects the app to run as uid 1000.
RUN useradd -m -u 1000 app
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
RUN chown -R app:app /app

USER app
EXPOSE 7860
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
