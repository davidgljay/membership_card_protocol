# Runs wallet-service under workerd via `wrangler dev`, matching its real
# Cloudflare Workers deployment target — same rationale as env/press's
# Dockerfile. Also used (via --entrypoint override, see docker-compose.yml)
# as the one-shot migration runner, since it already has the full
# node_modules + source needed for `npm run migrate`.
#
# Build context is the repo root: wallet-service/package.json depends on
# @membership-card-protocol/verifier via a `file:../membership_card_verifier/
# packages/verifier` link — a sibling directory outside wallet-service/
# entirely. That package's dist/ is gitignored (built, not committed), so
# it must be built here, before wallet-service's own install.
FROM node:23

# Pinned to match press's env/Dockerfile — pnpm 10+ defaults to blocking
# dependency build/postinstall scripts unless explicitly approved
# (`pnpm approve-builds`), which esbuild's postinstall needs.
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate

WORKDIR /repo/membership_card_verifier/packages/verifier
COPY membership_card_verifier/packages/verifier/package.json membership_card_verifier/packages/verifier/pnpm-lock.yaml* ./
RUN pnpm install
COPY membership_card_verifier/packages/verifier/ ./
RUN npm run build

WORKDIR /repo/wallet-service
COPY wallet-service/package.json wallet-service/pnpm-lock.yaml* ./
# pnpm's patchedDependencies (package.json) references patches/*.patch —
# needed before `pnpm install`, not just at the later full-source COPY.
COPY wallet-service/patches/ ./patches/
RUN pnpm install
COPY wallet-service/ ./
RUN NITRO_PRESET=cloudflare-module npm run build

# entrypoint.sh overrides the chain-related vars with the local devnode's
# freshly-deployed contract address — see its own doc comment. The
# wallet-service-migrate service (docker-compose.yml) overrides this
# ENTRYPOINT directly, so it's unaffected.
COPY integration_tests/env/wallet-service/entrypoint.sh /repo/entrypoint.sh
RUN chmod +x /repo/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/repo/entrypoint.sh"]
