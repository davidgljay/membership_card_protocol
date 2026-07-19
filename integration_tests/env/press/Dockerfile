# Runs press under workerd via `wrangler dev`, matching its real Cloudflare
# Workers deployment target (per strategic plan §Rationale Goal 1) rather
# than a plain-Node preset.
#
# Build context is the repo root: press/package.json depends on
# @membership-card-protocol/verifier via a `file:../membership_card_verifier/
# packages/verifier` link — a sibling directory outside press/ entirely, the
# same cross-directory-dependency shape wallet-service/matrix/Dockerfile
# has for matrix-policy-module. That package's dist/ is gitignored (built,
# not committed), so it must be built here, before press's own install,
# not just linked.
FROM node:23

# Pinned to match the version used elsewhere in this repo — pnpm 10+
# defaults to blocking dependency build/postinstall scripts unless
# explicitly approved (`pnpm approve-builds`), which esbuild's postinstall
# needs.
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate

WORKDIR /repo/membership_card_verifier/packages/verifier
COPY membership_card_verifier/packages/verifier/package.json membership_card_verifier/packages/verifier/pnpm-lock.yaml* ./
RUN pnpm install
COPY membership_card_verifier/packages/verifier/ ./
RUN npm run build

WORKDIR /repo/press
COPY press/package.json press/pnpm-lock.yaml* ./
RUN pnpm install
COPY press/ ./
RUN NITRO_PRESET=cloudflare-module npm run build

# wrangler dev reads .dev.vars from its own working directory at runtime
# (mounted by docker-compose.yml, not baked into the image — see
# env/press/.dev.vars), and wrangler.toml (committed in press/, generic —
# same convention as wallet-service/wrangler.toml).
EXPOSE 3000
ENTRYPOINT ["npx", "wrangler", "dev", ".output/server/index.mjs", "--site", ".output/public", "--ip", "0.0.0.0", "--port", "3000"]
