FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run lint && npm run security:check
ENV NODE_ENV=production
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
