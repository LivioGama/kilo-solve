FROM oven/bun:latest
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
EXPOSE 3333
CMD ["bun", "run", "src/dashboard.ts"]
