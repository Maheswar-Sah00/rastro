# Rastro threat model

Scope: the demonstration as built (synthetic GTAs on real environmental layers, HerdLedger on anvil or a public testnet, static web app, read-only API). Adversaries are the actors laundering already involves.

## Assets

1. The "clean" status of a lot of cattle, which is worth money (export access, EUDR compliance).
2. The integrity of risk verdicts and their evidence.
3. Herd balances and GTA records as seen by every buyer.
4. Privacy of ranch owners (no CPF, CNPJ or CAR codes).
5. Oracle and role keys.

## Adversaries and what stops them

| # | Adversary / attack | Control | Where |
|---|---|---|---|
| T1 | Launderer ships more head than it holds (paper cattle) | `InsufficientHerd` revert; conservation invariant | `HerdLedger.recordMovement`, invariant suite |
| T2 | Phantom births to legitimise smuggled animals | `BirthsExceedBiology` (breeding cows × 85 %/yr) | `recordBirths` |
| T3 | Embargoed ranch keeps selling | `OriginEmbargoed`; regulator-only `setEmbargo` | `recordMovement` |
| T4 | Same GTA reused for two lots / verdict shopping | `DuplicateGta`, `GtaAlreadyCertified`; flagged lots burn their GTAs | `recordMovement`, `issueCertificate` |
| T5 | One clean certificate backs two shipments or two EUDR statements | `CertificateAlreadyUsed`; `CertificateNotClean`; `CertificateRevoked` | `consumeCertificate` |
| T6 | Someone edits a verdict's evidence after the fact | SHA-256 of the evidence file anchored on-chain; the browser re-hashes the published bytes | `attestRisk`, `web/src/lib/evidence.ts` |
| T7 | Rollback to an older "clean" attestation | `StaleAttestation`; single-use nonces | `attestRisk` |
| T8 | Forged or replayed oracle message | EIP-712 with chain id + contract address; signer must hold ORACLE_ROLE; malleability rejected | `attestRisk`, `issueCertificate` |
| T9 | Oracle key leak | key only in gitignored env files used by replay tooling; regulator can revoke certificates; admin can revoke ORACLE_ROLE, which invalidates every unrelayed message | `contracts/.env.example`, AccessControl |
| T10 | Key exposed in the browser | the web app never signs; only `VITE_*` variables reach the bundle and none hold secrets; live demos use `eth_call` | `web/` |
| T11 | Bad or tampered data served to the UI | API validates every file against schema v1 and refuses violations with 500 | `backend/app/services/datasets.py` |
| T12 | Re-identification of ranchers from on-chain data | only salted hashes on-chain; salts stay with the registrar | SPEC §4 |
| T13 | Honest fast traders falsely accused | pass-through alone is *watch*, high only with ≥ 35 % flagged supply; 5–25 % traces go to review, not fail | `pipeline/detect.py` |

## Trusted parties and residual risks

- **Registrar / issuer are trusted to transcribe real GTAs.** The ledger only guarantees that what they transcribe is physically possible and identical for every buyer. A forged paper GTA that is physically plausible passes. Capacity and biology checks catch some, ear tags (Pará, 2030) are the long-term fix.
- **The oracle is trusted for its verdicts.** Verdicts are signed, evidence-hashed and revocable, so errors are attributable and correctable, not prevented.
- **Breeding-cow counts are declared at registration** with no census update yet; an inflated declaration widens the birth bound.
- **Lineage is FIFO within a farm**, an estimate. Lot-level traces are probabilistic, which is why borderline lots go to review.
- **Synthetic evaluation.** Results are measured against the simulator's ground truth; the ranch-level score is partly circular because dirty sources are defined from the same real layers. Nothing here establishes a legal violation by any real ranch or company.
- **Availability.** A public RPC outage only disables live `eth_call`; the UI falls back to recorded results.
- **Admin key.** `DEFAULT_ADMIN_ROLE` can grant roles. On a public network it should be a multisig; in the demo it is the deployer.
