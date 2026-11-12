# AWS Nitro Enclaves root certificate

`AWS_NitroEnclaves_Root-G1.der` is the DER form of the root in `AWS_NitroEnclaves_Root-G1.zip`, downloaded
from `https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip` (749 bytes) on 2026-11-12.

SHA-256 fingerprint of the certificate, as documented by AWS
(`https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html`), and matched here:

    64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B

Subject and issuer `C=US, O=Amazon, OU=AWS, CN=aws.nitro-enclaves`; ECDSA P-384, `ecdsa-with-SHA384`;
valid 2019-10-28 to 2049-10-28.

This is one of the three places allowed to hold AWS attestation-format material (G5). The Rust verifier
(`notary-attest::aws`) and the TypeScript module (`notary-attestation/src/aws-nitro-enclaves.ts`) embed
these bytes; each has a test that checks the fingerprint above.
