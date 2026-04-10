# ------------ Build Frontend ------------
FROM node:20-alpine AS fe-build
WORKDIR /app
COPY frontend ./frontend
WORKDIR /app/frontend
RUN npm ci && npm run build

# ------------ Build Backend ------------
FROM node:20-alpine AS be-build
WORKDIR /app
COPY backend ./backend
WORKDIR /app/backend
RUN npm ci && npm run build

# ------------ Final Image --------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Copy backend source for production install + compiled dist
COPY --from=be-build /app/backend/package.json /app/backend/package-lock.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev
# Copy compiled backend
COPY --from=be-build /app/backend/dist ./dist
# Copy frontend built assets
COPY --from=fe-build /app/frontend/dist /app/frontend/dist
# Copy db folder (schema)
COPY db /app/db
EXPOSE 8080
CMD ["node", "dist/server.js"]
