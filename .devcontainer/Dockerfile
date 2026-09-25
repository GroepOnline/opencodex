FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG BUN_VERSION=1.4.0

USER vscode
ENV BUN_INSTALL=/home/vscode/.bun
ENV PATH=/home/vscode/.bun/bin:${PATH}

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
