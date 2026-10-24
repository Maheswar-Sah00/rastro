# HerdLedger events

Every state change emits at least one event. Indexed fields are marked `indexed` and can be filtered
with `eth_getLogs`. Ids (`ranch`, `sink`, `gtaHash`, `lotId`, `shipment`) are salted 32-byte commitments,
never personal data. Signatures are as declared in `src/IHerdLedger.sol` and OpenZeppelin.

## Registry and herd ledger

| Event | Emitted by | Fields |
|---|---|---|
| `RanchRegistered(bytes32 indexed ranch, uint32 capacityHead, uint32 initialHead, uint32 breedingCows, bytes32 geomHash)` | `registerRanch` | opening balance, pasture capacity, declared breeding cows, hash of the off-chain polygon |
| `SinkRegistered(bytes32 indexed sink, uint8 kind)` | `registerSink` | `kind` 1 slaughterhouse, 2 export port |
| `BirthsRecorded(bytes32 indexed ranch, uint16 indexed year, uint32 head, uint32 yearTotal, uint32 balance)` | `recordBirths` | births added, cumulative births that year, new balance |
| `DeathsRecorded(bytes32 indexed ranch, uint32 head, uint32 balance)` | `recordDeaths` | deaths, new balance |
| `MovementRecorded(bytes32 indexed gtaHash, bytes32 indexed from, bytes32 indexed to, uint32 head, uint8 purpose, uint64 date)` | `recordMovement` | GTA commitment, origin, destination (ranch or sink), head, purpose 0–4, permit date |
| `CapacityExceeded(bytes32 indexed ranch, uint32 head, uint32 capacity)` | `registerRanch`, `recordBirths`, `recordMovement` | soft signal (no revert) when a ranch holds more than capacity × 110 % |

## Regulator

| Event | Emitted by | Fields |
|---|---|---|
| `EmbargoSet(bytes32 indexed ranch, bool on, bytes32 reasonHash, address indexed regulator)` | `setEmbargo`, `setEmbargoUntil` | every placement, re-assertion, lift and correction; `reasonHash` points to the decision document |
| `EmbargoExpirySet(bytes32 indexed ranch, uint64 expiresAt, address indexed regulator)` | `setEmbargoUntil` | the embargo stops blocking at `expiresAt` (no event is emitted when it expires; read `isEmbargoed`) |
| `CertificateRevocation(bytes32 indexed lotId, bytes32 reasonHash, address indexed regulator)` | `revokeCertificate` | named so because `CertificateRevoked` is the revert error |

The embargo history of a ranch is the ordered list of its `EmbargoSet` / `EmbargoExpirySet` events; the
`ranch()` view only holds the current state.

## Oracle, certificates and evidence

| Event | Emitted by | Fields |
|---|---|---|
| `RiskAttested(bytes32 indexed ranch, uint8 riskClass, uint16 scoreBps, bytes32 evidenceHash, uint64 asOf, address indexed oracle, uint256 nonce)` | `attestRisk` | risk class 0 clean, 1 watch, 2 high; SHA-256 of the evidence bundle; signer and nonce |
| `CertificateIssued(bytes32 indexed lotId, bytes32 indexed sink, uint32 head, uint8 verdict, bytes32 evidenceHash, bytes32[] gtaHashes, address indexed oracle, uint256 nonce)` | `issueCertificate` | verdict 0 clean, 1 flagged, 2 unknown, 3 review; the GTAs bound to the lot |
| `CertificateTerms(bytes32 indexed lotId, bytes32 indexed shipment, uint64 issuedAt, uint64 expiresAt, uint16 policyVersion)` | `issueCertificate` | signed shipment commitment, validity window and risk-policy version (emitted right after `CertificateIssued`) |
| `CertificateConsumed(bytes32 indexed lotId, uint8 use, bytes32 refHash, address indexed buyer)` | `consumeCertificate` | `use` 0 export shipment, 1 EUDR DDS, 2 retail claim; `refHash` is the commitment of the **consuming** shipment / DDS |
| `EvidenceAnchored(bytes32 indexed evidenceHash, bytes32 indexed subject, bytes32 uriHash, uint16 schemaVersion, address indexed by)` | `anchorEvidence` | evidence commitment, what it is about, hash of where it is published |

## Administration (OpenZeppelin)

| Event | Emitted by | Fields |
|---|---|---|
| `RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)` | constructor, `grantRole` | oracle registry changes are `RoleGranted` / `RoleRevoked` on `ORACLE_ROLE` |
| `RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)` | `revokeRole`, `renounceRole` | |
| `RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)` | not used by HerdLedger | |
| `Paused(address account)` / `Unpaused(address account)` | `pause` / `unpause` | |
| `MinPolicyVersionSet(uint16 minPolicyVersion, address indexed admin)` | `setMinPolicyVersion` | certificates below this policy version can no longer be issued |
| `EIP712DomainChanged()` | never (immutable domain) | part of EIP-5267 |

## Reading state instead of events

`oracles()` lists the current oracle signers, `certificateStatus(lotId)` gives `None / Valid / Consumed /
Revoked / NotClean / Expired`, `isEmbargoed(ranch)` the live embargo state, `evidence(hash)` an anchored
record, `totals()` and `isConserved()` the ledger-wide conservation check.
