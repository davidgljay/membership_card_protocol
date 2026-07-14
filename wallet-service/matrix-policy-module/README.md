# matrix-policy-module

Synapse spam-checker module that enforces Card Protocol room policy.

Implements `specs/object_specs/matrix_synapse_module.md`. Built into the
`synapse` Docker image at build time (`wallet-service/matrix/Dockerfile`) —
not fetched at runtime.

See `plans/matrix-implementation-plan.md` Phase 3 for the step-by-step build
history and rationale of each module.

## Development

```
pip install -e .[dev]
pytest
```
