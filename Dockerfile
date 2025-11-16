FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# Используем полную установку, чтобы были dev-зависимости для сборки
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3001
CMD ["npm", "run", "start:prod"]