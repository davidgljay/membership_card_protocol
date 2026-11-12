# notary/deploy

- `docker-compose.yml`: production shape (host + Redis + vsock proxy). Not run: no AWS resources (CP8).
- `docker-compose.sim.yml`: local/CI shape against the simulator. The host half is done; the enclave service needs the
  runtime from step 5.3, so this has **not** been run end to end.
- `Dockerfile.host`: the host image (build context: repository root). Not built in step 5.5.
- `aws/`: the pinned AWS Nitro Enclaves root certificate and its fingerprint.
- `eif/`: the enclave image recipe (Phase 8).
