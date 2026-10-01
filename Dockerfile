# Regatta's sandbox image: language-agnostic. Repo code and agent code run
# here and are treated as untrusted; the container has no internet and no
# credentials (egress goes through Regatta's Worker).
#
# Keep the donor tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

# glibc (not Alpine) so mise can install precompiled toolchains (Node, Ruby,
# Python, Go, Rust) instead of compiling them at runtime.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config xz-utils unzip \
      libssl-dev libyaml-dev zlib1g-dev libffi-dev libreadline-dev \
    && rm -rf /var/lib/apt/lists/*

# mise installs whatever toolchain a repo pins (or a manifest implies) at runtime.
ARG MISE_VERSION=v2026.9.18
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Every toolchain and package manager writes under /cache, so one R2 tarball
# warms any ecosystem. Bump REGATTA_IMAGE_GENERATION when this list changes:
# it's part of the cache key.
ENV REGATTA_IMAGE_GENERATION=2 \
    MISE_DATA_DIR=/cache/mise \
    MISE_YES=1 \
    PATH=/cache/mise/shims:$PATH \
    XDG_CACHE_HOME=/cache/xdg \
    npm_config_cache=/cache/npm \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    YARN_CACHE_FOLDER=/cache/yarn \
    PNPM_HOME=/cache/pnpm \
    PIP_CACHE_DIR=/cache/pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_CACHE_DIR=/cache/uv \
    BUNDLE_PATH=/cache/bundle \
    GEM_HOME=/cache/gems \
    GOMODCACHE=/cache/gomod \
    GOCACHE=/cache/gobuild \
    CARGO_HOME=/cache/cargo

# All egress is TLS-intercepted by Regatta's Worker; its CA is added to the
# system bundle at container start. Runtimes that ship their own root store
# (Node, Python's certifi, Rust/rustls tools like mise and cargo) must be told
# to use the system bundle, or every download fails as self-signed.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt

COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace /cache \
    && git config --system user.name regatta \
    && git config --system user.email regatta@localhost \
    # Untrusted repos must never pick up executable git config or hooks.
    && git config --system core.hooksPath /dev/null \
    && git config --system protocol.file.allow never
CMD ["sleep", "infinity"]
