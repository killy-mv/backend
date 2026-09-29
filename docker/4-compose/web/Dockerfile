FROM node:22-alpine
WORKDIR /app

# Copy only package.json first and install. This layer is cached, so editing
# server.js later doesn't re-run npm install; only a dependency change does.
COPY package.json .
RUN npm install --omit=dev

COPY server.js .
CMD ["node", "server.js"]
