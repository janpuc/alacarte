FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV args=""

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       gcc \
       libc6-dev \
  && rm -rf /var/lib/apt/lists/*

COPY ./rootfs /app/rootfs
COPY ./wrapper /app
COPY ./strtok_fix.c /app
COPY ./watch.js /app
WORKDIR /app

RUN gcc -shared -fPIC -O2 -o /app/libwrapper_strtok_fix.so /app/strtok_fix.c -ldl

EXPOSE 10020 20020 30020

CMD ["node", "/app/watch.js"]
