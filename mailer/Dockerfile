FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production --no-package-lock

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
