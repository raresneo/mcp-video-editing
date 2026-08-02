FROM node:22-bookworm-slim

# ffmpeg + ffprobe + fonts pentru diacritice RO (drawtext) + libs sharp.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  fonts-dejavu-core \
  fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "dist/index.js"]
