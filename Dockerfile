FROM node:20-alpine
WORKDIR /usr/src/app

# Upgrade all OS packages to latest patched versions
RUN apk update && apk upgrade --no-cache

# Build-time arg for GitHub Packages authentication.
# Passed in by the CI pipeline via --build-arg NODE_AUTH_TOKEN=<token>.
# Written to .npmrc for the install step, then deleted so it never
# survives into the final image layer.
ARG NODE_AUTH_TOKEN

# Docker context is the repo root ('.'), not services/ — paths are bare.
COPY package*.json ./

RUN echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" > .npmrc && \
  (npm ci --omit=dev || npm install --omit=dev) && \
  rm -f .npmrc

COPY src ./src

USER node

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3001/health/startup || exit 1
CMD ["node", "src/index.js"]



#try