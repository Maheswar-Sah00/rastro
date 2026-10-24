# Rastro contracts: `HerdLedger`

*A cow is born once, dies once, and can't be in two places. Neither can its paperwork.*

`HerdLedger` is the shared ledger behind Rastro. The state animal-health agency, Ibama, meatpackers,
exporters and importers do not trust each other, but they can all trust one contract that refuses
paperwork the herd itself could not have produced. The off-chain detection model (the "oracle") signs
risk attestations and lot certificates with EIP-712; anyone can relay them, and the ledger anchors the
evidence hash so a verdict cannot be edited later.

Solidity 0.8.30 (`^0.8.24`), OpenZeppelin Contracts 5.7 (AccessControlEnumerable, EIP712, ECDSA, Multicall,
Pausable), Foundry 1.8.

**What the chain is and is not.** HerdLedger enforces the validity of submitted state transitions under its
rules: balances are conserved, a GTA is used once, births stay within the declared biology, an embargoed
origin cannot ship, a certificate is consumed at most once. It cannot establish physical facts nobody
verified: the true number of breeding cows, whether a declared birth happened, or whether the animals on a
valid GTA really moved. Those remain declarations by the registrar.

Modules (one contract, separated in the source): ranch registry · herd ledger (births, deaths, GTAs) ·
regulator (embargoes, revocation) · oracle registry (`ORACLE_ROLE`, enumerable) · certificate registry
(EIP-712, single-use GTAs, one-time consumption, expiry, policy version) · evidence registry · emergency
pause. Every event: [EVENTS.md](EVENTS.md). Typed data, evidence serialisation and hashing:
[TYPED_DATA.md](TYPED_DATA.md).

```
src/HerdLedger.sol         the ledger
src/IHerdLedger.sol        structs, custom errors, events, external interface
script/Deploy.s.sol        deploy + role grants (anvil defaults, env overrides)
test/unit/                 one test per function and per revert path
test/fuzz/                 property tests against independent models
test/invariant/            handler-based stateful invariant suite
test/integration/          replays the committed pipeline fixture inside the EVM
test/script/               Deploy.s.sol behaviour
test/fixtures/chain_seed.sample.json   small seed derived from the pipeline output
replay/replay.mjs          seed -> chain replay, writes out/onchain.json (SPEC §6.8)
replay/local-demo.mjs      anvil + deploy + replay in one command
deploy-testnet.sh          Base Sepolia (default) / Polygon Amoy in one command
```

## What each function enforces

| Function | Caller | Enforces | Why it matters for laundering |
|---|---|---|---|
| `registerRanch` | REGISTRAR | unique non-zero id, opening balance, capacity, breeding cows | every animal on the ledger starts from a declared herd; ids are salted hashes, no CPF/CNPJ/CAR on-chain |
| `registerSink` | REGISTRAR | kind is slaughterhouse (1) or export port (2) | animals that reach a sink leave the live herd for good and can never come back as "clean" stock |
| `recordBirths` | REGISTRAR | cumulative births per ranch-year <= breeding cows × 85 % (`BirthsExceedBiology`) | blocks "phantom births" that legitimise animals bought from a dirty farm |
| `recordDeaths` | REGISTRAR | cannot kill more animals than the ranch holds (`InsufficientHerd`) | keeps balances honest so conservation stays meaningful |
| `recordMovement` | ISSUER | known entities, origin is a ranch, GTA hash used once (`DuplicateGta`), origin not embargoed (`OriginEmbargoed`), origin holds the head (`InsufficientHerd`); emits `CapacityExceeded` above capacity × 110 % | an intermediary cannot resell animals it never received, the same GTA cannot be reused, an embargoed farm cannot ship |
| `setEmbargo` | REGULATOR | ranch exists; start time kept when re-asserted; makes the embargo open-ended; `on = false` lifts or corrects it (reason hash = the correcting decision) | an Ibama embargo is enforced across every buyer at once, not only the meatpacker that checks |
| `setEmbargoUntil` | REGULATOR | expiry in the future (`InvalidValidity`); the embargo stops blocking at `expiresAt` with no further transaction | time-limited restrictions expire on schedule; `isEmbargoed` reports the live state |
| `attestRisk` | anyone (oracle-signed) | EIP-712 signer holds ORACLE_ROLE, single-use nonce, class <= 2, score <= 10000, not older than the stored attestation (`StaleAttestation`) | the model's risk verdict and evidence hash are public and cannot be rolled back to an older "clean" |
| `issueCertificate` | anyone (oracle-signed) | every GTA exists, went to this sink, is not in another certificate (`GtaAlreadyCertified`); lot head <= GTAs' head; non-zero shipment commitment; `issuedAt` <= now + 15 min, now < `expiresAt`, validity <= 5 years (`InvalidValidity`); policy version >= `minPolicyVersion` (`PolicyVersionRetired`) | whole-GTA, single-use certification: each GTA backs at most one lot whatever its verdict; flagged and review lots burn their GTAs, so nobody can shop for a better verdict |
| `consumeCertificate` | BUYER | exists; non-zero consuming-shipment commitment; not revoked (`CertificateRevoked`), not used (`CertificateAlreadyUsed`), verdict clean (`CertificateNotClean`: flagged, unknown and review never pass), not expired (`CertificateExpired`) | one clean lot backs one export shipment or one EUDR due-diligence statement, never two |
| `anchorEvidence` | ORACLE | non-zero hash and subject; each hash once (`EvidenceAlreadyAnchored`) | evidence bundles that are not attestations (decision reports, corrected traces) get a tamper-evident timestamp |
| `setMinPolicyVersion` | ADMIN | non-zero | certificates signed under a retired risk policy can no longer be issued |
| `pause` / `unpause` | PAUSER / ADMIN | see "Emergency pause" | emergency stop without losing auditability |
| `revokeCertificate` | REGULATOR | exists, not already revoked | new evidence withdraws a lot; its GTAs stay bound so they cannot be re-packaged |
| `multicall` | anyone | each inner call runs its own role check as the original sender; nothing is payable | batches thousands of GTAs per tx in the replay without weakening any rule |

Views: `balanceOf`, `ranch`, `sink`, `gta`, `certificate`, `certificateGtas`, `certificateStatus`
(`None`, `Valid`, `Consumed`, `Revoked`, `NotClean`, `Expired`), `riskOf`, `birthsInYear`, `isEmbargoed`,
`evidence`, `isOracle`, `oracles` (every authorised signer), `minPolicyVersion`, `paused`, `getRoleMembers`,
`isNonceUsed`, `totals`, `isConserved` (Σ ranch balances == Σ initial + Σ births
− Σ deaths − Σ head delivered to sinks), `hashRiskAttestation`, `hashCertificate`, `DOMAIN_SEPARATOR`,
`eip712Domain` (EIP-5267). Every state change emits an event.

EIP-712 domain: name `Rastro HerdLedger`, version `1`, chain id, contract address.

```
RiskAttestation(bytes32 ranch,uint8 riskClass,uint16 scoreBps,bytes32 evidenceHash,uint64 asOf,uint256 nonce)
Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,bytes32 shipment,uint32 head,uint8 verdict,bytes32 evidenceHash,uint64 issuedAt,uint64 expiresAt,uint16 policyVersion,uint256 nonce)
```

Verdicts map the risk engine's decision layer: `0` clean (PASS), `1` flagged (FLAGGED), `2` unknown,
`3` review (REVIEW). Only `0` can ever be consumed.

Nonces are unordered and single-use per oracle signer (shared by both message types), so relayers can
submit in any order. A signature for another chain or another deployment does not verify, and revoking
ORACLE_ROLE invalidates every unrelayed message from that key.

## Emergency pause and recovery

- `PAUSER_ROLE` (granted to the admin at deployment) can `pause()`. While paused, registration, births,
  deaths, movements, risk attestations, certificate issuance and consumption, and evidence anchoring revert
  with `EnforcedPause`. Protective regulator actions (`setEmbargo`, `setEmbargoUntil`, `revokeCertificate`)
  and role administration keep working.
- Only `DEFAULT_ADMIN_ROLE` can `unpause()`, so a compromised pauser can stop the ledger but not resume it.
- Key compromise: the admin `revokeRole`s the key. Revoking `ORACLE_ROLE` invalidates every message that key
  signed and nobody relayed yet; issued certificates can be withdrawn with `revokeCertificate`. Use a
  multisig as admin on any public network (`ADMIN_ADDRESS` in `Deploy.s.sol` hands over admin and pauser).

## Setup

```bash
# Foundry (any of these): foundryup, or the Windows binaries kept locally in .tools/bin:
gh release download v1.8.6 --repo foundry-rs/foundry --pattern 'foundry_v1.8.6_win32_amd64.zip' -D .tools
unzip .tools/foundry_v1.8.6_win32_amd64.zip -d .tools/bin && export PATH="$PWD/.tools/bin:$PATH"

forge soldeer install      # OpenZeppelin 5.7.0 + forge-std 1.17.0 into dependencies/ (pinned in soldeer.lock)
npm install                # ethers 6.17.0 for the replay helper
```

## Tests

```bash
forge test                          # all suites (~2 min, mostly the invariant campaign)
forge test --match-path "test/unit/*"
forge test --match-path "test/invariant/*" -vv   # prints the per-selector call table
FOUNDRY_PROFILE=deep forge test     # 20,000 fuzz runs, 1,000 x 200-call invariant runs
forge coverage --no-match-coverage "(script|test|dependencies)"
```

| Suite | Tests | What it covers |
|---|---|---|
| `test/unit` | 200 | every function, every custom error, every role check, events, EIP-712 encoding (recomputed independently), signature malleability, wrong chain / wrong contract, multicall atomicity; `Safeguards.t.sol`: certificate expiry and validity window, retired policy versions, shipment commitments, review verdict, certificate replay across chains and contracts, pause, timed embargoes and corrections, evidence and oracle registries, oracle key rotation |
| `test/fuzz` | 20 | 1,000 runs each: biology bound, conservation along random chains, capacity threshold, GTA uniqueness, certificate head bound, random keys / random signature bytes, stale attestations, consume-at-most-once (all four verdicts) |
| `test/invariant` | 12 invariants | 256 runs × 100 calls (25,600 calls per campaign) over 16 handler actions: 11 honest flows and 5 attacks |
| `test/integration` | 5 | replays `chain_seed.sample.json`: all events accepted, herd conserved, the four demo attacks fail with the expected errors |
| `test/script` | 1 | Deploy.s.sol defaults on anvil, env overrides and admin hand-over on a public chain id |

Coverage of `src/HerdLedger.sol`: 100 % lines (277/277), statements (324/324), branches (65/65) and
functions (49/49).

Last full run: `forge test` → 227 tests passed, 0 failed (10 suites). The deployed contract is 23,215 bytes
at `optimizer_runs = 1_000`; at 10,000 runs it exceeds the 24,576-byte EIP-170 limit.

Invariants (handler `test/invariant/LedgerHandler.sol`, with `fail_on_revert = true` so honest actions
must succeed and attack actions must fail with the specific error):

1. Conservation: Σ ranch balances (read one by one) == Σ initial + Σ births − Σ deaths − Σ head into sinks, and == `totals().ranchHead`.
2. No negative balance: each balance equals an independent signed model and is >= 0; overdrafts never pass.
3. A certificate is consumed at most once, and only when clean.
4. A GTA is in at most one certificate; the GTA→lot and lot→GTA bindings agree.
5. An embargoed ranch has no outgoing movement after the embargo (its `totalOut` is frozen).
6. Sinks received exactly the head that left ranches for sinks.
7. Per-ranch flow identity (head = initial + births + in − deaths − out) and Σ out == Σ in + Σ to sinks.
8. Births never exceed breeding cows × 85 % for any ranch-year.
9. Every certificate is backed by GTAs delivered to its sink covering its head.
10. Oracle messages are never replayed or forged.
11. Every attack is rejected with the error the rule defines.
12. Registry and flow counters match what was recorded.

## Local deployment and replay

One command (starts anvil, deploys, replays the seed, writes outputs, stops anvil):

```bash
npm run demo:local                       # uses ../pipeline/out/chain_seed.json, else the sample fixture
npm run demo:local -- path/to/seed.json --keep   # keep anvil running for the web app
```

Step by step:

```bash
anvil --gas-limit 300000000                                   # terminal 1
forge script script/Deploy.s.sol --rpc-url anvil --broadcast  # roles: #1 registrar+issuer, #2 regulator, #3 buyer, #5 oracle
node replay/replay.mjs ../pipeline/out/chain_seed.json        # address taken from broadcast/
```

The replay:

1. checks the seed offline against a JavaScript mirror of the ledger rules (reports the first failing event before sending anything),
2. registers sinks and ranches, applies `events` in order (births, deaths, movements, embargoes),
3. relays oracle-signed risk attestations and certificates (signed with the oracle key: anvil #5 by default).
   Certificates get the terms the pipeline seed does not carry: `issuedAt` = latest block time,
   `expiresAt` = +365 days, `policyVersion` = 1, `shipment` = SHA-256(`rastro-demo-salt-v1|` + shipment id),
4. consumes the clean demo certificate once,
5. simulates four expected failures with `eth_call` (no failing tx is mined) and records the decoded revert:
   `CertificateAlreadyUsed` (double consumption), `CertificateNotClean` (flagged lot),
   `OriginEmbargoed` (GTA out of an embargoed ranch), `BirthsExceedBiology` (phantom births),
6. writes `out/onchain.json` (SPEC §6.8, plus additive fields: `totals`, `conserved`, `calls`, `gas_used`, `roles`, `demo`;
   `attestRisk`, `issueCertificate`, `consumeCertificate` and certificate `revertDemo` records also carry `evidence_hash` / `lot_id`)
   and a per-network copy `out/onchain.<network>.json`, then copies `onchain.json` and `HerdLedger.abi.json` to
   `../web/public/data/`. An anvil run never overwrites a public-testnet `onchain.json` in the web app unless
   `--force-web` is given.

Options: `--subset [N]` (or `REPLAY_SUBSET`) replays the seed's `subset` block, or with N the smallest
conservation-feasible slice around the first N demo shipments; `--certs N|all` (full mode, default 100
besides the demo lots); `--batch N` calls per multicall (default 250 on anvil, 1 elsewhere);
`--records all|key`; `--address`, `--rpc`, `--env-file`, `--out`, `--web-dir`, `--no-web`.

Measured on the real pipeline seed (414 ranches, 7 sinks, 13,565 events, 193 attestations, 102
certificates): 14,282 calls in 92 transactions, about 65 s on anvil, zero unexpected reverts,
`isConserved() == true`.

## Public testnet (Base Sepolia by default, Polygon Amoy optional)

Put a throwaway key in `.env.testnet` (see `.env.example`; `.env*` is gitignored), fund it, then:

```bash
./deploy-testnet.sh                # Base Sepolia, chain 84532, https://sepolia.basescan.org
./deploy-testnet.sh amoy           # Polygon Amoy, chain 80002, https://amoy.polygonscan.com
```

The script checks the chain id and balance, deploys with `forge script` (the same key holds every role
and signs as the oracle), verifies the source on Sourcify (plus Basescan / Polygonscan when
`ETHERSCAN_API_KEY` is set), replays the demo subset one call per transaction, and publishes
`onchain.json` + ABI to the web app. Gas measured in a local rehearsal: deploy + role grants about
6.4 M gas, subset replay 9.5 M gas in 67 transactions, about 16 M gas in total. On Base Sepolia that is
roughly 0.0001 ETH at typical testnet prices (it prints the estimate for the current gas price before
sending anything); on Amoy, with its 25-30 gwei minimum tip, plan for about 0.6 POL.

Manual verification, if the automatic step was skipped or failed:

```bash
ARGS=$(cast abi-encode "constructor(address)" <deployer>)
forge verify-contract <address> src/HerdLedger.sol:HerdLedger --chain 84532 --verifier sourcify --constructor-args $ARGS --watch
forge verify-contract <address> src/HerdLedger.sol:HerdLedger --chain 84532 --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY --constructor-args $ARGS --watch
```

## Design notes and limits

- Trust model: the registrar and issuer (state agency) are trusted to transcribe GTAs; the ledger makes
  sure that what they transcribe is physically possible and that every buyer sees the same state. The
  oracle is trusted for its verdicts, which are signed, evidence-hashed and revocable by the regulator.
- Births are bounded by the breeding cows declared at registration; there is no census update function yet.
- A revoked certificate keeps its GTAs, so a corrected lot needs a regulator-side process off-chain.
- Real GTAs can be cancelled within their validity window; cancellation is not modelled.
- Balances are `uint32` per ranch and `uint64` in totals; overflow reverts (checked arithmetic).
- All ranch, herd and GTA data in the seed is synthetic, calibrated to public aggregates (see the root README).
