FROM matrixdotorg/synapse:latest

# matrix_policy_module (the Synapse policy module, matrix_synapse_module.md)
# and its dependency membership-card-verifier (still pending PyPI publish —
# see matrix-policy-module/pyproject.toml's own note) are pip-installed into
# this image's Python environment at build time, not just copied as raw
# source files. Synapse's own interpreter needs the package to be a real
# installed package on sys.path — a bare COPY to an arbitrary path (the
# original form of this Dockerfile) leaves it unimportable. This was a real
# bug, found and fixed during Phase 6 Step 22's first live boot
# (2026-07-14): Synapse failed at startup with
# `ModuleNotFoundError: No module named 'matrix_policy_module'`.
#
# Directory layout is preserved exactly as it is in the repo
# (membership_card_verifier/packages/verifier-py alongside wallet-service/,
# both siblings under the repo root) so matrix-policy-module/pyproject.toml's
# relative `file:` dependency path resolves correctly during pip install
# without needing to be rewritten for the image. This requires the build
# context to be the repo root, not wallet-service/ alone — see
# docker-compose.yml's synapse service (`context: ..`).
COPY membership_card_verifier/packages/verifier-py /build/membership_card_verifier/packages/verifier-py
COPY wallet-service/matrix-policy-module /build/wallet-service/matrix-policy-module

# pip resolves a pyproject.toml's relative `file:` dependency URL against
# its own current working directory, not the target package's directory —
# WORKDIR here must match where the relative path in matrix-policy-module's
# pyproject.toml (`file:./../../membership_card_verifier/packages/verifier-py`)
# actually expects to resolve from.
WORKDIR /build/wallet-service/matrix-policy-module
RUN pip install --no-cache-dir .

# membership-card-verifier's cryptography>=47.0.0 floor (needed for ML-DSA
# support) upgrades cryptography past what this base image's pinned
# pyOpenSSL was built against — pyOpenSSL wraps cryptography's cffi
# bindings directly, and an unpinned-in-tandem upgrade broke it at import
# time with `AttributeError: module 'lib' has no attribute 'GEN_EMAIL'`
# (Synapse's own Twisted networking stack imports pyOpenSSL, so this
# crashed the whole homeserver process, not just the module). pip's
# resolver doesn't catch this automatically since matrix-policy-module
# doesn't declare pyOpenSSL as a dependency at all — it's Synapse's own
# transitive dependency, upgraded here explicitly, in the same install
# step, to a version that actually supports cryptography>=47. Found and
# fixed during Phase 6 Step 22's first live boot (2026-07-14).
RUN pip install --no-cache-dir --upgrade "pyOpenSSL>=25.0.0"

# Precompile bytecode for the module and its heavier dependencies (web3's
# own import chain alone was measured at 100s+ cold on this build
# environment's CPU/filesystem) so the *first* real Synapse startup after
# this image is built doesn't pay that cost — .pyc files are baked into the
# image layer, not regenerated per-container-start. Found necessary during
# Phase 6 Step 22's first live boot (2026-07-14): Synapse's health check
# was timing out before the module finished importing on a cold cache.
RUN python -m compileall -q /usr/local/lib/python3.13/site-packages/matrix_policy_module \
    /usr/local/lib/python3.13/site-packages/membership_card_verifier \
    /usr/local/lib/python3.13/site-packages/web3 \
    /usr/local/lib/python3.13/site-packages/eth_abi \
    /usr/local/lib/python3.13/site-packages/eth_account \
    /usr/local/lib/python3.13/site-packages/parsimonious \
    || true
