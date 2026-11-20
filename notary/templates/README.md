# notary/templates

Audited `notary_v1` programs that a community activates with a policy and no code (implementation step 6.x; `plans/notary-questions-phase-6.md` Q3).

| Template | Step | What it computes |
|---|---|---|
| `aggregate/` | 6.1 | A histogram of one integer value per contributor: `count`, `sum`, and up to eight buckets whose edges (`edge_1 … edge_7`) are job parameters |
| `vote/` | 6.2 | A ballot tally with up to eight options and abstain, in fixed slots (`option_1 … option_8`, `abstain`). The question and the option labels are job parameters shown to voters; the program never reads them |
| `vote-yna/` | 6.2 | The yes/no/abstain vote of the spec's example (`yes`, `no`, `abstain`) |
| `derive/` | 6.4 | The derived-card program: copies the source card's projected fields verbatim. Its output schema is empty; the runtime checks the output equals the projected values (D4), and `policy.json` is the template policy `T` |

Each template is a crate with `src/lib.rs` (the logic, testable natively through `notary-guest`'s harness), `schema.json` (its output schema in canonical form, embedded in the module as `notary.output_schema`) and `policy.json` (the policy's `notary` section with placeholders: the contributor predicate, `program_cid`, and the community's `k_min`).

**A template's output schema is fixed.** Admission (A9) requires the module's schema to equal the policy's byte for byte, and the schema includes the privacy transforms (clamps, small-cell suppression). A community chooses who may contribute, `k_min` and the job's parameters. A different shape is a different module (`dedicated`, labelled "custom program" in the wallet).

## Building

```bash
templates/build.sh aggregate            # (or vote, vote-yna, derive) writes templates/modules/aggregate.wasm
templates/build.sh aggregate --check    # CI: the committed module equals a fresh build
```

The build uses the pinned toolchain (`rust-toolchain.toml`), path remapping and fixed linker flags, then `normalize/` re-encodes the module canonically and keeps only the two exports a `notary_v1` module may have. Two builds in different directories give identical bytes. The committed modules are in `modules/`; the program CID is `cidOfBytes(module)`, which the tests compute.

Allowlist publication (the governance program list, §34) is a governance action in step 7.1 and needs CP7.
