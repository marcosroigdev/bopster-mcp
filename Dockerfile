# Bopster MCP (Streamable HTTP). Holds no keys.
# Two stages: build with dev dependencies, run with production ones only.

FROM node:22-slim AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack installs the pnpm pinned in package.json's packageManager. Unpinned, it pulls
# pnpm 11, whose `pnpm build` fails on the esbuild build script tsx brings in.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Owned by root and only read at runtime: the server never writes to its own files.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Unprivileged user: a bug in a public endpoint shouldn't come with root.
USER node
EXPOSE 8788
CMD ["node", "dist/bin/http.js"]
