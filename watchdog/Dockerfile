FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY watchdog ./watchdog
COPY config ./config
CMD ["npx", "tsx", "watchdog/src/index.ts"]
