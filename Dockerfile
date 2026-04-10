# ------------ Build Frontend ------------
FROM node:20-alpine AS fe-build
WORKDIR /app
COPY frontend ./frontend
WORKDIR /app/frontend
RUN npm ci && npm run build

# ------------ Build Backend ------------
FROM node:20-alpine AS be-build
WORKDIR /app
# Copy root package files (workspace config + lockfile)
COPY package.json package-lock.json ./
COPY backend ./backend
WORKDIR /app/backend
RUN npm ci && npm run build

# ------------ Final Image --------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Copy root package files for workspace-aware production install
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
WORKDIR /app/backend
RUN cd /app && npm ci --omit=dev --workspace=backend
# Copy compiled backend
COPY --from=be-build /app/backend/dist ./dist
# Copy frontend built assets
COPY --from=fe-build /app/frontend/dist /app/frontend/dist
# Copy db folder (schema)
COPY db /app/db
EXPOSE 8080
CMD ["node", "dist/server.js"]
