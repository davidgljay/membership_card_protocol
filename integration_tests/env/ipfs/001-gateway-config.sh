#!/bin/sh
# Runs via kubo's official /container-init.d/ hook, after `ipfs init` but
# before the daemon starts. Kubo's gateway defaults to subdomain-style
# redirects (<cid>.ipfs.localhost:8080) for browser origin isolation, which
# doesn't resolve for direct path-style fetches from other containers —
# press's kubo IpfsPinningProvider (press/src/ipfs/kubo.ts) does a plain
# `GET <gateway>/ipfs/<cid>`. Disabling subdomains makes the gateway serve
# path-style responses directly, which is what a local dev/test gateway
# needs.
ipfs config --json Gateway.PublicGateways '{"localhost":{"UseSubdomains":false,"Paths":["/ipfs","/ipns"]}}'
