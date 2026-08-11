FROM node:22.16-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data PROJECT_BRAIN_DIR=/app/project-brain
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "apps/control-plane/src/index.ts"]
