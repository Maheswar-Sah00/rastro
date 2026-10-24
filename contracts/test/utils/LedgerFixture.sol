// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";

/// @notice Shared deployment, actors and EIP-712 helpers for the unit and fuzz suites.
/// @dev EIP-712 digests are recomputed here from first principles (not via the contract's own
///      `hash*` views) so the tests independently check the typed-data encoding.
abstract contract LedgerFixture is Test {
    HerdLedger internal ledger;

    address internal admin = makeAddr("admin");
    address internal registrar = makeAddr("registrar"); // state agency registry desk
    address internal issuer = makeAddr("issuer"); // state agency GTA desk
    address internal regulator = makeAddr("regulator"); // Ibama
    address internal buyer = makeAddr("buyer"); // exporter
    address internal buyer2 = makeAddr("buyer2"); // importer
    address internal relayer = makeAddr("relayer"); // anyone
    address internal stranger = makeAddr("stranger");

    address internal oracle;
    uint256 internal oraclePk;
    address internal rogue; // a key that does not hold ORACLE_ROLE
    uint256 internal roguePk;

    // A small world: breeder -> intermediary -> fattener -> slaughterhouse / port.
    bytes32 internal constant BREEDER = keccak256("ranch:R0001");
    bytes32 internal constant MIDDLEMAN = keccak256("ranch:R0002");
    bytes32 internal constant FATTENER = keccak256("ranch:R0003");
    bytes32 internal constant SLAUGHTERHOUSE = keccak256("sink:SIF_1234");
    bytes32 internal constant PORT = keccak256("sink:P:BARCARENA");
    bytes32 internal constant UNKNOWN = keccak256("nobody");

    uint32 internal constant BREEDER_CAP = 1000;
    uint32 internal constant BREEDER_INIT = 800;
    uint32 internal constant BREEDER_COWS = 300; // max 255 births / year
    uint32 internal constant MIDDLEMAN_CAP = 200;
    uint32 internal constant FATTENER_CAP = 2000;
    uint32 internal constant FATTENER_INIT = 500;

    uint64 internal constant DATE = 1_675_209_600; // 2023-02-01
    bytes32 internal constant GEOM = keccak256("geom:R0001");
    bytes32 internal constant EVIDENCE = keccak256("evidence:v1");
    bytes32 internal constant REASON = keccak256("ibama:auto-de-infracao:0001");

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant RISK_TYPEHASH = keccak256(
        "RiskAttestation(bytes32 ranch,uint8 riskClass,uint16 scoreBps,bytes32 evidenceHash,uint64 asOf,uint256 nonce)"
    );
    bytes32 internal constant CERT_TYPEHASH = keccak256(
        "Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,bytes32 shipment,uint32 head,uint8 verdict,bytes32 evidenceHash,uint64 issuedAt,uint64 expiresAt,uint16 policyVersion,uint256 nonce)"
    );

    uint256 internal nextNonce = 1;
    uint64 internal constant VALIDITY = 365 days;
    uint16 internal constant POLICY = 1;

    function setUp() public virtual {
        (oracle, oraclePk) = makeAddrAndKey("oracle");
        (rogue, roguePk) = makeAddrAndKey("rogue");

        ledger = new HerdLedger(admin);
        vm.startPrank(admin);
        ledger.grantRole(ledger.REGISTRAR_ROLE(), registrar);
        ledger.grantRole(ledger.ISSUER_ROLE(), issuer);
        ledger.grantRole(ledger.REGULATOR_ROLE(), regulator);
        ledger.grantRole(ledger.ORACLE_ROLE(), oracle);
        ledger.grantRole(ledger.BUYER_ROLE(), buyer);
        ledger.grantRole(ledger.BUYER_ROLE(), buyer2);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // World builders
    // ---------------------------------------------------------------------------------------------

    function _registerWorld() internal {
        vm.startPrank(registrar);
        ledger.registerRanch(BREEDER, BREEDER_CAP, BREEDER_INIT, BREEDER_COWS, GEOM);
        ledger.registerRanch(MIDDLEMAN, MIDDLEMAN_CAP, 0, 0, keccak256("geom:R0002"));
        ledger.registerRanch(FATTENER, FATTENER_CAP, FATTENER_INIT, 0, keccak256("geom:R0003"));
        ledger.registerSink(SLAUGHTERHOUSE, 1);
        ledger.registerSink(PORT, 2);
        vm.stopPrank();
    }

    function _registerRanch(bytes32 id, uint32 cap, uint32 init, uint32 cows) internal {
        vm.prank(registrar);
        ledger.registerRanch(id, cap, init, cows, keccak256(abi.encode("geom", id)));
    }

    function _registerSink(bytes32 id, uint8 kind) internal {
        vm.prank(registrar);
        ledger.registerSink(id, kind);
    }

    function _births(bytes32 id, uint32 head, uint16 year) internal {
        vm.prank(registrar);
        ledger.recordBirths(id, head, year);
    }

    function _deaths(bytes32 id, uint32 head) internal {
        vm.prank(registrar);
        ledger.recordDeaths(id, head);
    }

    function _move(bytes32 gtaHash, bytes32 from, bytes32 to, uint32 head) internal {
        vm.prank(issuer);
        ledger.recordMovement(gtaHash, from, to, head, 3, DATE);
    }

    function _embargo(bytes32 id, bool on) internal {
        vm.prank(regulator);
        ledger.setEmbargo(id, on, REASON);
    }

    function _gtaHash(string memory gtaNumber) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("salt:", gtaNumber));
    }

    function _lot(string memory shipment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("lot:", shipment));
    }

    function _list(bytes32 a) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = a;
    }

    function _list(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = a;
        l[1] = b;
    }

    /// @dev Registers the world and delivers two GTAs into the slaughterhouse (300 + 200 head).
    function _worldWithDeliveries() internal returns (bytes32 g1, bytes32 g2) {
        _registerWorld();
        g1 = _gtaHash("GTA-1");
        g2 = _gtaHash("GTA-2");
        _move(g1, BREEDER, SLAUGHTERHOUSE, 300);
        _move(g2, FATTENER, SLAUGHTERHOUSE, 200);
    }

    // ---------------------------------------------------------------------------------------------
    // EIP-712 (independent re-implementation)
    // ---------------------------------------------------------------------------------------------

    function _domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Rastro HerdLedger")),
                keccak256(bytes("1")),
                // forge-lint: disable-next-line(environment-read-across-mutation)
                block.chainid, // read live on purpose: tests switch chains to prove replay protection
                verifyingContract
            )
        );
    }

    function _riskDigest(IHerdLedger.RiskAttestation memory a, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(RISK_TYPEHASH, a.ranch, a.riskClass, a.scoreBps, a.evidenceHash, a.asOf, a.nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(verifyingContract), structHash));
    }

    function _certDigest(IHerdLedger.Certificate memory c, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                CERT_TYPEHASH,
                c.lotId,
                c.sink,
                keccak256(abi.encodePacked(c.gtaHashes)),
                c.shipment,
                c.head,
                c.verdict,
                c.evidenceHash,
                c.issuedAt,
                c.expiresAt,
                c.policyVersion,
                c.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(verifyingContract), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRisk(uint256 pk, IHerdLedger.RiskAttestation memory a)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, _riskDigest(a, address(ledger)));
    }

    function _signCert(uint256 pk, IHerdLedger.Certificate memory c) internal view returns (bytes memory) {
        return _sign(pk, _certDigest(c, address(ledger)));
    }

    function _risk(bytes32 ranchId, uint8 riskClass, uint16 scoreBps, uint64 asOf)
        internal
        returns (IHerdLedger.RiskAttestation memory a)
    {
        a = IHerdLedger.RiskAttestation({
            ranch: ranchId,
            riskClass: riskClass,
            scoreBps: scoreBps,
            evidenceHash: EVIDENCE,
            asOf: asOf,
            nonce: nextNonce++
        });
    }

    function _cert(bytes32 lotId, bytes32 sinkId, bytes32[] memory gtas, uint32 head, uint8 verdict)
        internal
        returns (IHerdLedger.Certificate memory c)
    {
        c = IHerdLedger.Certificate({
            lotId: lotId,
            sink: sinkId,
            gtaHashes: gtas,
            shipment: keccak256(abi.encode("shipment", lotId)),
            head: head,
            verdict: verdict,
            evidenceHash: EVIDENCE,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + VALIDITY,
            policyVersion: POLICY,
            nonce: nextNonce++
        });
    }

    function _attest(IHerdLedger.RiskAttestation memory a) internal {
        bytes memory sig = _signRisk(oraclePk, a);
        vm.prank(relayer);
        ledger.attestRisk(a, sig);
    }

    function _issue(IHerdLedger.Certificate memory c) internal {
        bytes memory sig = _signCert(oraclePk, c);
        vm.prank(relayer);
        ledger.issueCertificate(c, sig);
    }

    function _consume(bytes32 lotId) internal {
        vm.prank(buyer);
        ledger.consumeCertificate(lotId, 0, keccak256("DDS-0001"));
    }

    // ---------------------------------------------------------------------------------------------
    // Revert-data helpers
    // ---------------------------------------------------------------------------------------------

    function _err(bytes4 sel, bytes32 a) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel, a);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", account, role);
    }
}
