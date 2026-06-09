FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/admin/index.html ./dist/admin/index.html
COPY prompts/ ./prompts/
COPY config/ ./config/
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
