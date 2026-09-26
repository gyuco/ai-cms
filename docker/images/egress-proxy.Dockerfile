FROM node:22-alpine
WORKDIR /app
COPY apps/egress-proxy/src ./src
USER node
EXPOSE 3128
CMD ["node", "src/main.ts"]
