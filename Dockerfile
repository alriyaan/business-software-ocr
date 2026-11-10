# Receipt OCR server for the Business Software demo APK.
# Node 22 (Debian slim) + Tesseract CLI + Python3/PIL (downscaling only).
# No API keys, no paid services. Listens on $PORT (Render / HF Spaces
# convention: the platform sets PORT; default 3000 locally).
FROM node:22-slim

# tesseract-ocr: the OCR engine. python3 + python3-pil: downscales very
# large photos before OCR (the demo client already caps at 1600 px, so
# this only bites on direct calls). ca-certificates is harmless here
# but keeps the image usable for any future HTTPS fetch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      python3 \
      python3-pil \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./

# No dependencies to install (zero-dependency server.js), but keep npm
# honest in case one is ever added.
RUN npm install --omit=dev --no-audit --no-fund || true

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
