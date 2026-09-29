# Each instruction is a layer. Docker caches layers and reuses them on the next
# build as long as nothing above them changed.

# 1. Start from an existing image: a tiny Linux (Alpine) with Node installed.
FROM node:22-alpine

# 2. All following paths are relative to /app inside the image.
WORKDIR /app

# 3. Copy our code from the build context (this folder) into the image.
COPY server.js .

# 4. Default configuration; can be overridden with `docker run -e`.
ENV PORT=3000

# 5. Documentation only: the app listens on 3000. Publishing is done with -p.
EXPOSE 3000

# 6. The command that runs when a container starts from this image.
CMD ["node", "server.js"]
