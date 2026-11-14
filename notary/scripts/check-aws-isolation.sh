#!/usr/bin/env bash
# G5 (acceptance criterion): only notary-attest::aws, the notary-attestation TypeScript package and
# notary/deploy may parse or produce the AWS Nitro Enclaves attestation format.
# Fails if format-specific terms appear in source files outside those places (code-plan §7.4).
# Also checks the terminology rule: no bare "Nitro" in new notary docs (nitropack and nitro-devnode excepted).
set -euo pipefail
cd "$(dirname "$0")/../.."

TERMS='cabundle|COSE_Sign1|(^|[^A-Za-z])nsm|641A0321|AWS_NitroEnclaves_Root'
ROOTS=(notary/runtime notary/sim notary/host notary/vectors-tools notary/scripts
       membership_card_verifier/packages/verifier/src wallet-sdk/packages/wallet-sdk/src relay/src)
ALLOWED='^(notary/attestation-ts/|notary/deploy/|notary/runtime/crates/notary-attest/src/aws\.rs$|notary/runtime/crates/notary-attest/tests/att_codes\.rs$|notary/runtime/crates/notary-attest/Cargo\.toml$|notary/scripts/check-aws-isolation\.sh$)'

fail=0
while IFS= read -r f; do
  if [[ ! "$f" =~ $ALLOWED ]]; then
    echo "G5 violation: $f"; grep -niE "$TERMS" "$f" | head -3 | sed 's/^/    /'; fail=1
  fi
done < <(grep -rIliE "$TERMS" "${ROOTS[@]}" --include='*.rs' --include='*.ts' --include='*.toml' --include='*.json' --include='*.sh' \
           --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=.vitest 2>/dev/null || true)

# Production runtime code (outside notary-attest and test directories) must not name the AWS module either: it talks to
# the platform-neutral `AttestationBackend` / `AttestationVerifier` and to `sim`. (Added in the 5.7 review: the format
# terms above can't see a call such as `notary_attest::aws::verify_envelope`.)
if grep -rInE 'attest::aws|aws::(verify|build|AwsVerifier)' notary/runtime notary/sim/src notary/host/src --include='*.rs' --include='*.ts' \
     --exclude-dir=node_modules --exclude-dir=target --exclude-dir=tests --exclude-dir=notary-attest | grep -v 'notary/sim/src/lib.rs'; then
  echo "G5 violation: production code names the AWS verifier module (use AttestationVerifier / sim)"; fail=1
fi

# bare "Nitro" in notary docs/sources (nitropack / nitro-devnode / Nitro-based words allowed)
if grep -rInE '\bNitro\b' notary --include='*.md' --include='*.rs' --include='*.ts' --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
     | grep -viE 'AWS Nitro Enclaves|nitropack|nitro-devnode|Nitro Attestation PKI' | grep -v 'check-aws-isolation.sh'; then
  echo "Terminology violation: bare \"Nitro\" (write \"AWS Nitro Enclaves\", \"the enclave\" or \"nitropack\")"; fail=1
fi

[ "$fail" = 0 ] && echo "AWS-format isolation: OK" || exit 1
