FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/runtime/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir /app/runtime && chown node:node /app/runtime
COPY --from=build /app/dist ./dist
COPY --from=build /app/build-server ./build-server
USER node
EXPOSE 3000
CMD ["npm", "start"]
