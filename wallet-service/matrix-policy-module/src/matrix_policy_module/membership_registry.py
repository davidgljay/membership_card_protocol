"""Persistent, encrypted membership registry (Step 12a).

Per matrix_join_attestation_and_revocation.md §2a, this is not solely
watch-set bookkeeping — it is the *only* mechanism by which the post hook
(module.py's check_event_for_spam) resolves `card_hash` for an already-joined
member, since posts carry no attestation of their own. It therefore stores,
per membership, both:

- the `(room_id, matrix_user_id) -> card_hash` association (post-time
  identity resolution), and
- the full set of watched addresses (leaf + every ancestor from that card's
  join-time chain walk) that membership depends on, so watcher.py (Step 11a)
  can reference-count the watch-set: an address is only dropped from the
  subscription filter once no active membership depends on it any longer.

Persistence: a single encrypted-at-rest file (AES-256-GCM), not a Synapse
Postgres table — this is module-internal state, not Matrix protocol state
(matrix_synapse_module.md's membership_registry_path). The encryption key is
read directly from membership_registry_key_path (a raw key file on a mounted
volume) — see matrix_synapse_module.md's corrected 2026-07-11 note: this
Python process has no way to call wallet-service's TS SecretsService at its
own startup, so the key is a plain file the module reads itself, the same
pattern used for the Synapse signing key and watcher admin token.

A row-level SQLite table would also satisfy the "persisted, encrypted"
requirement; a single encrypted JSON blob is used here instead since the
whole registry is small (bounded by concurrent active room memberships on
this one homeserver) and a single-file read/decrypt/re-encrypt/write cycle
is simpler to reason about and test than a SQLite+per-row-encryption scheme
for a dataset this size.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NONCE_LENGTH = 12


class RegistryStateError(RuntimeError):
    """Raised when the registry file exists but can't be decrypted/parsed —
    per matrix_join_attestation_and_revocation.md §3.3, the module must fail
    loudly at startup rather than start with an empty registry silently."""


@dataclass
class MembershipEntry:
    card_hash: str
    watched_addresses: list[str]
    joined_at: str


class MembershipRegistry:
    def __init__(self, path: str, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("membership registry key must be 32 bytes (AES-256)")
        self._path = Path(path)
        self._aesgcm = AESGCM(key)
        self._memberships: dict[tuple[str, str], MembershipEntry] = {}
        self._load()

    @classmethod
    def from_key_path(cls, path: str, key_path: str) -> "MembershipRegistry":
        # generate-matrix-secrets.ts writes this file as base64url text (its
        # own comment: "AES-256 key (raw, base64url in the file)"), with a
        # trailing newline — not raw key bytes. Reading it as raw bytes gave
        # a 44-byte value (base64url(32 bytes) with padding) instead of the
        # 32 raw bytes __init__ requires, failing loudly with "must be 32
        # bytes" rather than silently accepting the wrong length. Found and
        # fixed during Phase 6 Step 22's first live boot (2026-07-14).
        import base64

        encoded = Path(key_path).read_text().strip()
        key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        return cls(path, key)

    # ---- persistence ----

    def _load(self) -> None:
        if not self._path.exists():
            return  # first boot — empty registry is expected, not an error
        raw = self._path.read_bytes()
        try:
            nonce, ciphertext = raw[:_NONCE_LENGTH], raw[_NONCE_LENGTH:]
            plaintext = self._aesgcm.decrypt(nonce, ciphertext, None)
            data = json.loads(plaintext)
        except Exception as e:
            raise RegistryStateError(
                f"membership registry at {self._path} exists but could not be decrypted/parsed: {e}"
            ) from e
        self._memberships = {
            tuple(row["key"]): MembershipEntry(
                card_hash=row["card_hash"],
                watched_addresses=row["watched_addresses"],
                joined_at=row["joined_at"],
            )
            for row in data
        }

    def _persist(self) -> None:
        data = [
            {"key": list(key), **asdict(entry)}
            for key, entry in self._memberships.items()
        ]
        plaintext = json.dumps(data).encode("utf-8")
        nonce = os.urandom(_NONCE_LENGTH)
        ciphertext = self._aesgcm.encrypt(nonce, plaintext, None)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_bytes(nonce + ciphertext)

    # ---- writes (join hook, watcher) ----

    def register(
        self, room_id: str, matrix_user_id: str, card_hash: str, watched_addresses: list[str], joined_at: str
    ) -> None:
        self._memberships[(room_id, matrix_user_id)] = MembershipEntry(
            card_hash=card_hash, watched_addresses=list(watched_addresses), joined_at=joined_at
        )
        self._persist()

    def remove_membership(self, room_id: str, matrix_user_id: str) -> None:
        """Room leave or force-part — removes the membership entirely, per
        §2a's "no reason to retain a card-identity binding for a membership
        that no longer exists"."""
        self._memberships.pop((room_id, matrix_user_id), None)
        self._persist()

    # ---- reads (post hook, watcher) ----

    def resolve_card_hash(self, room_id: str, matrix_user_id: str) -> Optional[str]:
        entry = self._memberships.get((room_id, matrix_user_id))
        return entry.card_hash if entry is not None else None

    def watched_addresses(self) -> set[str]:
        """Union across every currently-registered membership — this is the
        watcher's subscription filter set (matrix_join_attestation_and_revocation.md §3.2)."""
        addresses: set[str] = set()
        for entry in self._memberships.values():
            addresses.update(entry.watched_addresses)
        return addresses

    def memberships_for_address(self, address: str) -> list[tuple[str, str]]:
        """Every (room_id, matrix_user_id) whose watch-set includes `address`
        — used by watcher.py to determine which rooms to force-part from on
        a detected revocation for that address."""
        return [
            key
            for key, entry in self._memberships.items()
            if address in entry.watched_addresses
        ]

    # ---- startup reconciliation (§2a) ----

    def reconcile(self, live_memberships: set[tuple[str, str]]) -> list[tuple[str, str]]:
        """Called once at startup against Synapse's live room-membership
        list. Prunes registry entries for memberships Synapse no longer
        reports (the member left while the module was down). Returns the
        list of live memberships with *no* registry entry — the caller
        (module.py) does not need to act on these beyond visibility; they
        naturally deny at next post via resolve_card_hash returning None,
        per §3.3's "membership_not_registered" row — this method does not
        deny anything itself, it only reports the gap."""
        stale = [key for key in self._memberships if key not in live_memberships]
        for key in stale:
            del self._memberships[key]
        if stale:
            self._persist()

        registered = set(self._memberships.keys())
        return [key for key in live_memberships if key not in registered]
