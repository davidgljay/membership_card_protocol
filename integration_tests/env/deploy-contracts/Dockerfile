# One-shot bootstrap container: waits for the Nitro devnode, deploys the
# three Stylus contracts against it, wires them, and writes
# deployments/local.json to the shared `contracts-deployments` volume.
#
# Build context is this directory; contracts/ is pulled in via the
# `contracts-src` additional build context (not the repo-root context), so
# this build doesn't need to touch the root .dockerignore — that file
# deliberately excludes contracts/ for the (unrelated) Synapse build that
# also uses the repo root as its context. See
# integration_tests/docker-compose.yml's deploy-contracts service.
FROM rust:1.96.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq xxd bc \
    && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown
RUN cargo install cargo-stylus --locked

# Foundry (forge/cast), pinned via foundryup's stable channel.
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:${PATH}"
RUN foundryup

WORKDIR /repo
COPY --from=contracts-src . ./contracts/
COPY bootstrap.sh ./bootstrap.sh
RUN chmod +x ./bootstrap.sh

ENTRYPOINT ["./bootstrap.sh"]
