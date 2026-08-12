# Official linux/arm64 Node 24 Bookworm slim image resolved on 2026-08-12.
# Do not replace this immutable digest with a mutable tag.
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# Git 2.48 introduced relative worktree paths and extensions.relativeWorktrees.
# Pin 2.50.1 to match the host version that creates the pilot worktrees. The
# SHA-256 is from Git's signed kernel.org sha256sums.asc manifest.
ARG GIT_VERSION=2.50.1
ARG GIT_SOURCE_SHA256=7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4

FROM ${NODE_BASE_IMAGE} AS git-builder
ARG GIT_VERSION
ARG GIT_SOURCE_SHA256

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    libcurl4-openssl-dev \
    libexpat1-dev \
    libssl-dev \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      --proto '=https' --tlsv1.2 --retry 3 \
      "https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
      --output /tmp/git.tar.xz \
  && printf '%s  %s\n' "${GIT_SOURCE_SHA256}" /tmp/git.tar.xz | sha256sum --check --strict \
  && mkdir /tmp/git-source \
  && tar --extract --xz --file /tmp/git.tar.xz --directory /tmp/git-source --strip-components=1

WORKDIR /tmp/git-source
RUN make -j2 prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease all \
  && make prefix=/opt/git NO_GETTEXT=YesPlease NO_TCLTK=YesPlease install

FROM ${NODE_BASE_IMAGE}
ARG GIT_VERSION
ARG GIT_SOURCE_SHA256

LABEL io.valkyrie.atomic.version="0.9.12" \
      io.valkyrie.git.version="${GIT_VERSION}" \
      io.valkyrie.git.source="https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
      io.valkyrie.git.source.sha256="${GIT_SOURCE_SHA256}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    libcurl4 \
    libexpat1 \
    openssh-client \
    perl \
    ripgrep \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=git-builder /opt/git /opt/git
ENV PATH=/opt/git/bin:$PATH
RUN ln -s /opt/git/bin/git /usr/bin/git \
  && test "$(/usr/bin/git --version)" = "git version ${GIT_VERSION}"

WORKDIR /opt/valkyrie-atomic
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && ln -s /opt/valkyrie-atomic/node_modules/.bin/atomic /usr/local/bin/atomic \
  && atomic --version

ENV HOME=/tmp/atomic-home \
    ATOMIC_CODING_AGENT_DIR=/tmp/atomic-agent \
    ATOMIC_CODING_AGENT_SESSION_DIR=/workspace/.atomic-sessions \
    ATOMIC_WORKFLOW_ARTIFACT_DIR=/workspace/.atomic-artifacts \
    ATOMIC_OFFLINE=1

WORKDIR /workspace/worktree
CMD ["sleep", "infinity"]
