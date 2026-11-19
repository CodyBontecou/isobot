# isobot's build sandbox: what a content-train (or other Linux-only) build needs, plus Claude Code.
# The donor image ships the shim that @cloudflare/sandbox's Files API runs in the Container.
# Keep its tag equal to the installed @cloudflare/sandbox version.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.3
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep python3 util-linux procps \
  && rm -rf /var/lib/apt/lists/*
# The postinstall script copies the native binary into place, so don't skip scripts.
RUN npm install --global @anthropic-ai/claude-code@2.1.318
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Commits are the builder's; the runner copies them out and pushes them itself.
RUN git config --system user.name isobot \
  && git config --system user.email isobot@users.noreply.github.com \
  && git config --system advice.detachedHead false \
  && printf '__pycache__/\n*.pyc\n.DS_Store\n' > /etc/gitignore \
  && git config --system core.excludesFile /etc/gitignore \
  && mkdir -p /workspace /isobot
WORKDIR /workspace
CMD ["sleep", "infinity"]
