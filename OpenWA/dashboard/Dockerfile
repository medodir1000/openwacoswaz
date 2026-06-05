FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies. --legacy-peer-deps: @vitejs/plugin-react@5's peer range
# doesn't list vite 8 yet, but they work together fine (the local build proves
# it). npm ci is strict about peers, so we relax it here.
RUN npm ci --legacy-peer-deps

# Copy source code
COPY . .

# Build the app
RUN npm run build

# Production stage with nginx
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx config as a TEMPLATE — the official image runs envsubst on
# /etc/nginx/templates/*.template at startup, injecting the vars below.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Defaults for local docker-compose; Railway overrides these via Variables:
#   PORT        (Railway sets this automatically)
#   GATEWAY_URL http://<openwa-service>.railway.internal:2785
#   BRAIN_URL   http://<brain-service>.railway.internal:5001
ENV PORT=80 \
    GATEWAY_URL=http://openwa:2785 \
    BRAIN_URL=http://brain:5001

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
