# HerdLedger typed data and evidence hashing

## EIP-712 domain

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name              "Rastro HerdLedger"
version           "1"
chainId           chain the ledger is deployed on
verifyingContract the HerdLedger address
```

The domain is readable on-chain through `eip712Domain()` (EIP-5267) and `DOMAIN_SEPARATOR()`. A signature
made for another chain or another deployment recovers a different address, which does not hold
`ORACLE_ROLE`, so it is rejected with `InvalidSigner`.

## Messages

```
RiskAttestation(bytes32 ranch,uint8 riskClass,uint16 scoreBps,bytes32 evidenceHash,uint64 asOf,uint256 nonce)

Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,bytes32 shipment,uint32 head,uint8 verdict,
            bytes32 evidenceHash,uint64 issuedAt,uint64 expiresAt,uint16 policyVersion,uint256 nonce)
```

`bytes32[] gtaHashes` is encoded as `keccak256(abi.encodePacked(gtaHashes))`, per EIP-712.

| Certificate field | Binds |
|---|---|
| `lotId` | certificate id |
| `sink` | slaughterhouse / port that received the GTAs |
| `gtaHashes` | the lot commitment: the exact GTAs (whole GTAs; each can back one certificate only) |
| `shipment` | commitment to the shipment / delivery the lot belongs to (Rastro: SHA-256(`rastro-demo-salt-v1\|` + shipment id)) |
| `head` | head in the lot (<= the GTAs' head) |
| `verdict` | risk decision: 0 clean (PASS), 1 flagged (FLAGGED), 2 unknown, 3 review (REVIEW); only 0 is consumable |
| `evidenceHash` | SHA-256 of the canonical evidence bundle (below) |
| `issuedAt`, `expiresAt` | validity window; `issuedAt` <= chain time + 15 min, chain time < `expiresAt`, window <= 5 years; consumption after `expiresAt` reverts `CertificateExpired` |
| `policyVersion` | risk-policy / schema version; must be >= `minPolicyVersion()` |
| `nonce` | unordered, single-use per signer, shared with `RiskAttestation` |
| oracle identity | the recovered signer, which must hold `ORACLE_ROLE` at relay time; stored as `CertificateRecord.oracle` |

Signing (ethers v6):

```js
const domain = { name: "Rastro HerdLedger", version: "1", chainId, verifyingContract: ledgerAddress };
const types = { Certificate: [
  { name: "lotId", type: "bytes32" }, { name: "sink", type: "bytes32" }, { name: "gtaHashes", type: "bytes32[]" },
  { name: "shipment", type: "bytes32" }, { name: "head", type: "uint32" }, { name: "verdict", type: "uint8" },
  { name: "evidenceHash", type: "bytes32" }, { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
  { name: "policyVersion", type: "uint16" }, { name: "nonce", type: "uint256" } ] };
const sig = await oracleWallet.signTypedData(domain, types, certificate);
await ledger.issueCertificate(certificate, sig); // any account may relay
```

`hashCertificate(c)` and `hashRiskAttestation(a)` return the digest the oracle signs, so an off-chain signer
can check its encoding against the deployed contract before signing (the replay does this).

The oracle key lives only in the trusted signing process (`contracts/replay`, a gitignored env file). It
never reaches the browser or the read-only API.

## Canonical evidence serialisation

An evidence bundle is a JSON object. Its commitment is:

```
evidenceHash = SHA-256( UTF-8( JSON with keys sorted at every level, no whitespace
                               (separators "," and ":"), non-ASCII characters written as-is ) )
```

In Python: `hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()`.
Numbers are written as the producer serialises them (Python floats rounded before hashing in the
pipeline), so the same logical bundle produced by the same pipeline version gives the same hash. The
published file is exactly those bytes (`web/public/data/evidence/<hash>.json`), so anyone can re-hash the
file and compare with the on-chain `evidenceHash`. The web app does this in the browser.

Ids inside bundles and on-chain (`ranch`, `sink`, `gtaHash`, `shipment`) are
`SHA-256("rastro-demo-salt-v1|" + public id)` in the demo.

## Salted hashes vs public reproducibility

| Choice | Who can verify | Risk |
|---|---|---|
| **Salted id commitments** (ranch codes, GTA numbers, shipment ids) | only parties who hold the salt (the registrar, and whoever it shares with) can link a commitment to a real code | without the salt, guessable codes (CAR numbers, sequential GTA numbers) cannot be confirmed by hashing candidates; this is what protects rancher privacy. The demo uses one published salt for reproducibility; a deployment would keep it secret and could use per-entity salts or a keyed hash (HMAC) |
| **Unsalted evidence hashes** (SHA-256 of the published bundle) | anyone who has the bundle | the bundle must contain only what may be public. Rastro bundles carry salted ids, flags, measured values and model versions, never personal data |
| **Unpublished evidence** (hash only, bundle shared on request) | auditors given the bundle | third parties can see that evidence existed at a time, not what it said |

A hash proves the bytes did not change after anchoring. It does not prove the content is true: the
evidence is only as good as the data and detector that produced it.

## Limits the contract cannot overcome

The ledger enforces the validity of submitted transitions. It cannot establish the true number of breeding
cows (the birth bound uses what the registrar declared), whether a declared birth physically occurred, or
whether a valid GTA's animals actually moved. Those are declarations by the authorised roles, made
attributable and conserved by the ledger, not verified by it.
