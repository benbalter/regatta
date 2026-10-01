# Keep the donor tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

# Ruby is here because the demo fleet is Jekyll plugins; CI runs `bundle exec rake`.
FROM ruby:3.4-alpine
RUN apk add --no-cache git build-base bash curl ca-certificates
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && git config --system user.name regatta && git config --system user.email regatta@localhost
CMD ["sleep", "infinity"]
