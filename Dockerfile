FROM node:lts-alpine

WORKDIR /app

COPY . /app

RUN npm ci

ENTRYPOINT [ "node", "server.js"]