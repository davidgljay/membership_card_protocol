# env/

Per-service Dockerfiles, wrangler configs, and bootstrap scripts for the
integration stack. One subdirectory (or file set) per service that needs
integration-stack-specific build/config beyond what its own package
already provides (e.g. the Nitro devnode contract-deploy bootstrap, the
press wrangler.toml written for this stack).

Services that already have a usable Dockerfile/compose fragment in their
own package (relay, Synapse) are referenced from the root
`docker-compose.yml` directly rather than duplicated here.
