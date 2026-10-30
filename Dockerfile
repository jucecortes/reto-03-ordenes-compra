# Imagen única: instala dependencias, compila el front y arranca el backend con Bun.
FROM oven/bun:1.4.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun x vite build

ENV NODE_ENV=production
# Render inyecta PORT; en local se usa 8787.
EXPOSE 8787
CMD ["bun", "src/server.ts"]
