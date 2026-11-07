FROM node:22-bookworm AS node
FROM rust:1.99.1-bookworm AS dev
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf libfuse2 git xvfb xauth zsync python3 dbus-x11 && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy
WORKDIR /app
ENV APPIMAGE_EXTRACT_AND_RUN=1
CMD ["bash"]

FROM dev AS ui-test
RUN apt-get update && apt-get install -y --no-install-recommends webkit2gtk-driver && rm -rf /var/lib/apt/lists/*
RUN cargo install tauri-driver --version 2.1.0 --locked

FROM dev AS default
