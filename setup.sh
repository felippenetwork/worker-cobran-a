#!/bin/sh
# Instala dependências do sistema necessárias para o Chrome/Puppeteer rodar em containers Linux
apt-get update
apt-get install -y libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 libxkbcommon0 libxrandr2 libxcomposite1 libxdamage1 libxfixes3 libx11-xcb1 libxshmfence1 libxext6 libxfixes3
