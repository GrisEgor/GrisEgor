# Собирается из каталога dom-byta/: docker build -f server/Dockerfile .
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY site /app/site

ENV SITE_DIR=/app/site UPLOADS_DIR=/app/uploads PORT=3000
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
