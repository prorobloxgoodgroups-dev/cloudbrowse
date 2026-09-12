#!/usr/bin/env bash
set -e
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  fonts-tlwg-loma-otf fonts-noto-cjk libnss3 libatk-bridge2.0-0 libgtk-3-0 \
  libasound2 libxshmfence1 libgbm1
sudo rm -rf /var/lib/apt/lists/*
npm install --no-audit --no-fund
echo
echo "Ready. Start it with:  npm start"
