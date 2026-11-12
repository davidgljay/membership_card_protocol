# EIF build recipe (placeholder)

The reproducible enclave image (EIF) build, with pinned inputs and a PCR0 script, belongs here (notary_runtime.md §2).
It needs the runtime from step 5.3 and AWS tooling, so it is written in Phase 8 and checked locally for
reproducibility (two `docker build`s, same digest) in step 7.1. Nothing here creates AWS resources (CP8).
