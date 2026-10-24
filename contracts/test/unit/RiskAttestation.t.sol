// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice attestRisk: EIP-712 oracle signatures, nonce replay protection, field validation.
contract RiskAttestationTest is LedgerFixture {
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public override {
        super.setUp();
        _registerWorld();
    }

    function test_AttestRisk_StoresLatestRecord() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 2, 8700, 1_735_689_600);
        _attest(a);
        IHerdLedger.RiskRecord memory r = ledger.riskOf(MIDDLEMAN);
        assertEq(r.riskClass, 2);
        assertEq(r.scoreBps, 8700);
        assertEq(r.asOf, 1_735_689_600);
        assertEq(r.oracle, oracle);
        assertEq(r.evidenceHash, EVIDENCE);
        assertTrue(ledger.isNonceUsed(oracle, a.nonce));
    }

    function test_AttestRisk_EmitsEvent() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 1, 5000, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectEmit(address(ledger));
        emit IHerdLedger.RiskAttested(MIDDLEMAN, 1, 5000, EVIDENCE, 100, oracle, a.nonce);
        ledger.attestRisk(a, sig);
    }

    function test_AttestRisk_RelayableByAnyAccount() public {
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 0, 100, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.prank(stranger); // holds no role at all
        ledger.attestRisk(a, sig);
        assertEq(ledger.riskOf(BREEDER).oracle, oracle);
    }

    function test_AttestRisk_NewerReplacesOlder() public {
        _attest(_risk(MIDDLEMAN, 0, 1000, 100));
        _attest(_risk(MIDDLEMAN, 2, 9100, 200));
        assertEq(ledger.riskOf(MIDDLEMAN).riskClass, 2);
        assertEq(ledger.riskOf(MIDDLEMAN).asOf, 200);
    }

    function test_AttestRisk_SameAsOfCorrectionAllowed() public {
        _attest(_risk(MIDDLEMAN, 1, 6000, 100));
        _attest(_risk(MIDDLEMAN, 2, 8000, 100));
        assertEq(ledger.riskOf(MIDDLEMAN).riskClass, 2);
    }

    function test_AttestRisk_ScoreBoundaries() public {
        _attest(_risk(BREEDER, 0, 0, 1));
        _attest(_risk(BREEDER, 2, 10_000, 2));
        assertEq(ledger.riskOf(BREEDER).scoreBps, 10_000);
    }

    function test_AttestRisk_SecondOracleHasItsOwnNonceSpace() public {
        (address oracle2, uint256 oracle2Pk) = makeAddrAndKey("oracle2");
        bytes32 role = ledger.ORACLE_ROLE();
        vm.prank(admin);
        ledger.grantRole(role, oracle2);

        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 0, 1, 1);
        ledger.attestRisk(a, _signRisk(oraclePk, a));
        IHerdLedger.RiskAttestation memory b = a;
        b.asOf = 2;
        ledger.attestRisk(b, _signRisk(oracle2Pk, b)); // same nonce, different signer
        assertEq(ledger.riskOf(BREEDER).oracle, oracle2);
    }

    function test_HashRiskAttestation_MatchesIndependentEip712Encoding() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 2, 8700, 1_735_689_600);
        assertEq(ledger.hashRiskAttestation(a), _riskDigest(a, address(ledger)));
    }

    // ------------------------------------------------------------------ reverts: signature

    function test_RevertWhen_AttestRisk_SameSignatureReplayed() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 2, 8700, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        ledger.attestRisk(a, sig);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.NonceAlreadyUsed.selector, oracle, a.nonce));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_NonceAlreadySpentByCertificate() public {
        (bytes32 gta1,) = _deliver();
        IHerdLedger.Certificate memory c = _cert(_lot("SHP-1"), SLAUGHTERHOUSE, _list(gta1), 300, 0);
        _issue(c);
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 0, 1, 1);
        a.nonce = c.nonce;
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.NonceAlreadyUsed.selector, oracle, c.nonce));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_SignerNotOracle() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        bytes memory sig = _signRisk(roguePk, a);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, rogue));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_FieldTamperedAfterSigning() public {
        // A launderer intercepts a "high" attestation and rewrites it as "clean".
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 2, 9500, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        a.riskClass = 0;
        a.scoreBps = 100;
        address recovered = ecrecover(_riskDigest(a, address(ledger)), uint8(sig[64]), _r(sig), _s(sig));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_SignatureTooShort() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        bytes memory short = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            short[i] = sig[i];
        }
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, address(0)));
        ledger.attestRisk(a, short);
    }

    function test_RevertWhen_AttestRisk_EmptySignature() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, address(0)));
        ledger.attestRisk(a, "");
    }

    function test_RevertWhen_AttestRisk_MalleableHighSSignature() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, _riskDigest(a, address(ledger)));
        // (r, n - s, v ^ 1) recovers the same key but is rejected as non-canonical.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, address(0)));
        ledger.attestRisk(a, abi.encodePacked(r, highS, flippedV));
    }

    function test_RevertWhen_AttestRisk_InvalidV() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        (, bytes32 r, bytes32 s) = vm.sign(oraclePk, _riskDigest(a, address(ledger)));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, address(0)));
        ledger.attestRisk(a, abi.encodePacked(r, s, uint8(29)));
    }

    function test_RevertWhen_AttestRisk_OracleRoleRevoked() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        bytes memory sig = _signRisk(oraclePk, a);
        bytes32 role = ledger.ORACLE_ROLE();
        vm.prank(admin);
        ledger.revokeRole(role, oracle); // key rotation / compromise response
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, oracle));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_SignedForAnotherChain() public {
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        bytes memory sig = _signRisk(oraclePk, a); // signed for the current chain id
        vm.chainId(80_002);
        bytes32 digestHere = _riskDigest(a, address(ledger));
        address recovered = ecrecover(digestHere, uint8(sig[64]), _r(sig), _s(sig));
        assertTrue(recovered != oracle);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_SignedForAnotherDeployment() public {
        HerdLedger other = new HerdLedger(admin);
        IHerdLedger.RiskAttestation memory a = _risk(MIDDLEMAN, 0, 0, 100);
        bytes memory sig = _sign(oraclePk, _riskDigest(a, address(other)));
        address recovered = ecrecover(_riskDigest(a, address(ledger)), uint8(sig[64]), _r(sig), _s(sig));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.attestRisk(a, sig);
    }

    // ------------------------------------------------------------------ reverts: fields

    function test_RevertWhen_AttestRisk_StaleAttestation() public {
        _attest(_risk(MIDDLEMAN, 2, 9000, 200));
        IHerdLedger.RiskAttestation memory old = _risk(MIDDLEMAN, 0, 100, 199);
        bytes memory sig = _signRisk(oraclePk, old);
        vm.expectRevert(
            abi.encodeWithSelector(IHerdLedger.StaleAttestation.selector, MIDDLEMAN, uint64(199), uint64(200))
        );
        ledger.attestRisk(old, sig);
    }

    function test_RevertWhen_AttestRisk_UnknownRanch() public {
        IHerdLedger.RiskAttestation memory a = _risk(UNKNOWN, 0, 0, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectRevert(_err(IHerdLedger.UnknownEntity.selector, UNKNOWN));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_OnSink() public {
        IHerdLedger.RiskAttestation memory a = _risk(PORT, 0, 0, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectRevert(_err(IHerdLedger.NotARanch.selector, PORT));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_InvalidRiskClass() public {
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 3, 0, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidRiskClass.selector, uint8(3)));
        ledger.attestRisk(a, sig);
    }

    function test_RevertWhen_AttestRisk_ScoreAbove10000() public {
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 0, 10_001, 1);
        bytes memory sig = _signRisk(oraclePk, a);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidScore.selector, uint16(10_001)));
        ledger.attestRisk(a, sig);
    }

    // ------------------------------------------------------------------ helpers

    function _deliver() internal returns (bytes32 gta1, bytes32 gta2) {
        gta1 = _gtaHash("GTA-R-1");
        gta2 = _gtaHash("GTA-R-2");
        _move(gta1, BREEDER, SLAUGHTERHOUSE, 300);
        _move(gta2, FATTENER, SLAUGHTERHOUSE, 200);
    }

    function _r(bytes memory sig) internal pure returns (bytes32 r) {
        assembly {
            r := mload(add(sig, 0x20))
        }
    }

    function _s(bytes memory sig) internal pure returns (bytes32 s) {
        assembly {
            s := mload(add(sig, 0x40))
        }
    }
}
