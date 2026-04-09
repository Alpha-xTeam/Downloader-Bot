FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages -U yt-dlp

COPY package*.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

COPY . .

CMD ["npm", "start"]