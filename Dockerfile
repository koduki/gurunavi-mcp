FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps --only-shell chromium \
    && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "dist/index.js"]
