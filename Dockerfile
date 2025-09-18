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
# Copy backend dist and node_modules
COPY --from=be-build /app/backend/dist ./backend/dist
COPY --from=be-build /app/backend/node_modules ./backend/node_modules
# Copy frontend built assets
COPY --from=fe-build /app/frontend/dist ./frontend/dist
# Copy db folder (schema)
COPY db ./db
EXPOSE 8080
WORKDIR /app/backend
CMD ["node", "dist/server.js"]
