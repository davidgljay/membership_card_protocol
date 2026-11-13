# notary/deploy

- `docker-compose.yml`: production shape (host + Redis + vsock proxy). Not run: no AWS resources (CP8).
- `docker-compose.sim.yml`: local/CI shape against the simulator (step 5.5): the host, Redis, the simulated enclave
  (`Dockerfile.runtime-sim`: `notary-runtime` + the fake enclave service) and a simulated chain/IPFS/EAS service
  (`Dockerfile.e2e`). Run the whole scenario with `notary/e2e/run-compose.sh`. Every key in `notary/e2e/sim.env` is a
  test value.
- `Dockerfile.host`: the host image (build context: repository root). Built and run in the simulator stack.
- `aws/`: the pinned AWS Nitro Enclaves root certificate and its fingerprint.
- `eif/`: the enclave image recipe (Phase 8).
