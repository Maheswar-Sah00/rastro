# Certificates: issuance, consumption, verification

A lot that the risk engine PASSES can receive an oracle-signed certificate on HerdLedger. A buyer can consume it once, and anyone can verify it independently against its evidence and the ledger.

## Canonical evidence bundle

`pipeline/rastro/certificates/bundle.py`, schema `rastro.evidence-bundle/1.0.0`. Contents:

- shipment id and salted commitment, destination, date, declared head;
- GTA ids, plus the GTA hashes the ledger recorded, and a lot commitment over them;
- the decision with its reasons, thresholds, decision evidence hash and assessment time;
- the lineage summary: policy, coverage, hops, sources, exposures, FIFO-vs-pro-rata sensitivity and uncertainty notes;
- findings, each with its own evidence hash;
- evidence record ids;
- dataset id, digest, seed and environmental layer versions;
- the detector version and the policy version (1);
- provenance and limitations.

**Serialisation.** The bundle is serialised with RFC 8785 (`rastro/certificates/jcs.py`; tested on the RFC's own example). SHA-256 is computed over exactly those bytes. The bundle is stored off-chain as `<dataset>/certificates/bundles/<sha256>.json`, and the hash goes on-chain as `evidenceHash`. Verifiers re-canonicalise and re-hash; a stored file that is not in canonical form fails verification.

**Commitments.** These are `sha256("rastro-demo-salt-v1|" + id)`.
- The salt stops anyone confirming a guessable id (GTA numbers, ranch codes) by brute force.
- The evidence hash stays publicly reproducible from the published bundle.
- The trade-off: linking a commitment back to an id needs the salt, which the registrar holds.

## Workflow

```bash
# local chain with the replayed state (keep it running)
contracts/.tools/bin/anvil --port 8545 --gas-limit 300000000 &
cd contracts && npm run demo:local -- --keep

cd pipeline
python -m rastro.certificates.issue issue    ../data/synthetic/evaluation SHP-D-000006
python -m rastro.certificates.issue consume  ../data/synthetic/evaluation <lot_id> --shipment SHP-D-000006
python -m rastro.certificates.issue resubmit ../data/synthetic/evaluation <lot_id>     # replay attempt
python -m rastro.certificates.issue demo     ../data/synthetic/evaluation              # all cases below
```

1. **Retrieve** the canonical decision and lineage.
2. **Refuse** anything but PASS. FLAGGED lots are refused; REVIEW lots are held until an investigator resolves them.
3. **Build** the bundle and **hash** its RFC 8785 bytes.
4. **Sign** the EIP-712 `Certificate` in `contracts/replay/certify.mjs`, the trusted signer. It is the only process that touches the oracle key: `ORACLE_PRIVATE_KEY`, falling back to anvil's public development key only on chain 31337. Keys never reach the backend or the browser.
5. **Check the digest** against `HerdLedger.hashCertificate`, **simulate** the call with `eth_call`, then **submit** `issueCertificate` and **wait for the receipt**.
6. **Record** what happened in `<dataset>/certificates/registry.jsonl`. Every refusal, rejection, issuance, consumption and replay attempt is logged, and chain fields are copied only from mined receipts or decoded simulated reverts.

The backend never signs. `POST /certificates/{id}/consume-request` returns unsigned calldata for the buyer's own wallet.

## Checks

| Check | Where | Demonstrated |
|---|---|---|
| FLAGGED / REVIEW lot | issuer refuses before signing; the contract also refuses to consume verdicts other than clean | SHP-D-000080 refused, SHP-D-000017 held |
| Duplicate issuance | issuer registry; contract `CertificateAlreadyIssued` / `GtaAlreadyCertified` | SHP-D-000001 second attempt refused; SHP-D-000002..5 rejected by the ledger (their GTAs were already certified by the replay) |
| Unauthorised signature | contract `InvalidSigner`; verifier `signer_is_oracle` | Foundry unit tests; backend verifier tests |
| Wrong chain id / verifying contract | EIP-712 domain; verifier `chain_id`, `verifying_contract` | live: a payload signed for chain 84532 is `invalid` |
| Changed evidence | verifier re-hashes the stored canonical bytes; `assessment_current` rebuilds the bundle from current outputs | live: one edited number → `invalid`; missing file → `unverifiable` |
| Expired / revoked / consumed | contract `CertificateExpired`, `CertificateRevoked`, `CertificateAlreadyUsed`; verifier reports the ledger state | live: second consumption reverts `CertificateAlreadyUsed` |
| Replay of a signed certificate | contract (nonce, lot id) | live: resubmission reverts `CertificateAlreadyIssued` |
| Mismatched shipment commitment | trusted consumption service, before any transaction | live: consuming for `SHP-D-999999` refused |

**Gap.** For export-shipment use, the contract does not yet require the consuming reference to equal the signed `shipment`. Only the trusted consumption service enforces it today. Adding `if (use == USE_EXPORT_SHIPMENT && refHash != cert.shipment) revert` (with its test updates) is the recommended next contract change.

## Recorded demo run (local anvil, chain 31337, HerdLedger `0x5FbDB2315678afecb367f032d93F642f64180aa3`)

| Case | Result |
|---|---|
| Eligible certificate | SHP-D-000001 issued, tx `0x672e6e8b…43c6`, block 99; SHP-D-000006 issued, tx `0x5153274f…680f`, block 101 (left unconsumed) |
| Blocked certificate | SHP-D-000080 (FLAGGED) refused before signing |
| Successful verification | `POST /api/v1/certificates/0x145400de…c018/verify` → `valid`, all 11 checks pass |
| Consumption | SHP-D-000001 consumed, tx `0x02467c8d…50be`, block 100 |
| Failed replay | resubmitting SHP-D-000001's signed certificate → `CertificateAlreadyIssued`; consuming it again → `CertificateAlreadyUsed` |

These are local-chain transactions, not a public testnet. The console labels them **Local chain (anvil)**. A public deployment is possible with `contracts/deploy-testnet.sh` and a funded key, but has not been executed.

## Independent verification

`POST /api/v1/certificates/{id}/verify`, optionally with `{certificate, signature, domain, bundle}` to verify a supplied payload. Each check is reported separately:

1. domain: chain id and verifying contract;
2. EIP-712 signature recovery (pure Python, malleable high-s signatures rejected);
3. `isOracle(signer)` on the ledger;
4. the evidence hash from the exact canonical bytes;
5. whether the assessment is still current;
6. the ledger's evidence hash, shipment and oracle;
7. expiry and `certificateStatus`.

The outcome is one of `valid`, `consumed`, `revoked`, `expired`, `not_clean`, `invalid`, `unverifiable` or `not_on_ledger`, with a reason. A hash present on-chain without the evidence file gives `unverifiable`, never success.

**Exports.** `GET /api/v1/certificates/{id}/report?format=html|json`. Both carry the shipment summary, provenance, lineage and quantities, findings, evidence hash, signature metadata, chain id and contract, transaction hash, verification time, and limitations. The console's Certificates page shows the issuance registry, the per-check verification and both downloads.
