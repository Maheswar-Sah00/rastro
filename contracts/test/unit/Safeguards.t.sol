// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {HerdLedger} from "../../src/HerdLedger.sol";
import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice Certificate terms (expiry, policy version, shipment, review verdict), emergency pause, timed
///         embargoes, the evidence registry, the oracle registry and certificate replay across domains.
contract SafeguardsTest is LedgerFixture {
    bytes32 internal g1;
    bytes32 internal g2;
    bytes32 internal lot = keccak256("lot:SHP-0011");
    bytes32 internal constant REF = keccak256("export:SHIP-2026-0099");

    function setUp() public override {
        super.setUp();
        vm.warp(1_760_000_000);
        (g1, g2) = _worldWithDeliveries();
    }

    // ------------------------------------------------------------------ certificate terms

    function test_IssueCertificate_StoresSignedTerms() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.issuedAt = uint64(block.timestamp) - 1 hours;
        c.policyVersion = 3;
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CertificateTerms(lot, c.shipment, c.issuedAt, c.expiresAt, 3);
        ledger.issueCertificate(c, sig);

        IHerdLedger.CertificateRecord memory r = ledger.certificate(lot);
        assertEq(r.shipment, c.shipment);
        assertEq(r.issuedAt, c.issuedAt);
        assertEq(r.expiresAt, c.expiresAt);
        assertEq(r.recordedAt, block.timestamp);
        assertEq(r.policyVersion, 3);
    }

    function test_RevertWhen_IssueCertificate_ZeroShipment() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.shipment = bytes32(0);
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.ZeroId.selector));
    }

    function test_RevertWhen_IssueCertificate_AlreadyExpired() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.issuedAt = uint64(block.timestamp) - 400 days;
        c.expiresAt = uint64(block.timestamp) - 35 days;
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.InvalidValidity.selector, c.issuedAt, c.expiresAt));
    }

    function test_RevertWhen_IssueCertificate_IssuedInTheFuture() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.issuedAt = uint64(block.timestamp) + 1 hours;
        c.expiresAt = c.issuedAt + 30 days;
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.InvalidValidity.selector, c.issuedAt, c.expiresAt));
    }

    function test_IssueCertificate_ToleratesClockSkew() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.issuedAt = uint64(block.timestamp) + 10 minutes;
        _issue(c);
        assertTrue(ledger.certificate(lot).issued);
    }

    function test_RevertWhen_IssueCertificate_ExpiryBeforeIssue() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.expiresAt = c.issuedAt;
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.InvalidValidity.selector, c.issuedAt, c.expiresAt));
    }

    function test_RevertWhen_IssueCertificate_ValidityTooLong() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.expiresAt = c.issuedAt + ledger.MAX_CERTIFICATE_VALIDITY() + 1;
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.InvalidValidity.selector, c.issuedAt, c.expiresAt));
    }

    function test_RevertWhen_IssueCertificate_RetiredPolicyVersion() public {
        vm.prank(admin);
        ledger.setMinPolicyVersion(2);
        assertEq(ledger.minPolicyVersion(), 2);
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0); // policy 1
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.PolicyVersionRetired.selector, uint16(1), uint16(2)));
    }

    function test_RevertWhen_IssueCertificate_PolicyVersionZero() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        c.policyVersion = 0;
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.PolicyVersionRetired.selector, uint16(0), uint16(1)));
    }

    function test_SetMinPolicyVersion_OnlyAdminAndNonZero() public {
        vm.expectRevert(_unauthorized(stranger, ledger.DEFAULT_ADMIN_ROLE()));
        vm.prank(stranger);
        ledger.setMinPolicyVersion(2);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.PolicyVersionRetired.selector, uint16(0), uint16(1)));
        vm.prank(admin);
        ledger.setMinPolicyVersion(0);
        vm.expectEmit(address(ledger));
        emit IHerdLedger.MinPolicyVersionSet(4, admin);
        vm.prank(admin);
        ledger.setMinPolicyVersion(4);
    }

    function test_RevertWhen_ConsumeCertificate_Expired() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        _issue(c);
        vm.warp(c.expiresAt); // last valid second
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Valid));
        vm.warp(uint256(c.expiresAt) + 1);
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Expired));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.CertificateExpired.selector, lot, c.expiresAt));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, REF);
    }

    function test_ConsumeCertificate_OnLastValidSecond() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        _issue(c);
        vm.warp(c.expiresAt);
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, REF);
        assertTrue(ledger.certificate(lot).consumed);
    }

    function test_RevertWhen_ConsumeCertificate_ZeroShipmentReference() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.ZeroId.selector));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, bytes32(0));
    }

    function test_ConsumeCertificate_EmitsConsumingShipment() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CertificateConsumed(lot, 0, REF, buyer);
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, REF);
        assertEq(ledger.certificate(lot).consumeRef, REF);
    }

    // ------------------------------------------------------------------ review verdict

    function test_ReviewVerdict_IsRecordedButNeverConsumable() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 3));
        assertEq(ledger.certificate(lot).verdict, ledger.VERDICT_REVIEW());
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.NotClean));
        vm.expectRevert(_err(IHerdLedger.CertificateNotClean.selector, lot));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, REF);
    }

    function test_ReviewVerdict_BurnsItsGtasForALaterCleanLot() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 3));
        bytes32 retry = keccak256("lot:retry");
        IHerdLedger.Certificate memory c = _cert(retry, SLAUGHTERHOUSE, _list(g1), 300, 0);
        _expectIssueRevert(c, abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, g1, lot));
    }

    // ------------------------------------------------------------------ replay across domains

    function test_RevertWhen_Certificate_SignedForAnotherChain() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        uint256 home = block.chainid;
        vm.chainId(80_002);
        bytes memory sig = _sign(oraclePk, _certDigest(c, address(ledger)));
        vm.chainId(home);
        address recovered = _recover(_certDigest(c, address(ledger)), sig);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.issueCertificate(c, sig);
    }

    function test_RevertWhen_Certificate_SignedForAnotherContract() public {
        HerdLedger other = new HerdLedger(admin);
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _sign(oraclePk, _certDigest(c, address(other)));
        address recovered = _recover(_certDigest(c, address(ledger)), sig);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.issueCertificate(c, sig);
    }

    function test_RevertWhen_Certificate_TermsAlteredAfterSigning() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c);
        c.expiresAt += 365 days; // a relayer tries to stretch the validity
        address recovered = _recover(_certDigest(c, address(ledger)), sig);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, recovered));
        ledger.issueCertificate(c, sig);
    }

    function test_HashCertificate_MatchesIndependentEncoding() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 500, 3);
        assertEq(ledger.hashCertificate(c), _certDigest(c, address(ledger)));
        assertEq(ledger.CERTIFICATE_TYPEHASH(), CERT_TYPEHASH);
    }

    // ------------------------------------------------------------------ pause

    function test_Pause_BlocksEveryLedgerTransition() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory csig = _signCert(oraclePk, c);
        IHerdLedger.RiskAttestation memory a = _risk(BREEDER, 2, 9000, DATE);
        bytes memory asig = _signRisk(oraclePk, a);

        vm.expectEmit(address(ledger));
        emit Pausable.Paused(admin);
        vm.prank(admin);
        ledger.pause();
        assertTrue(ledger.paused());
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);

        vm.startPrank(registrar);
        vm.expectRevert(paused);
        ledger.registerRanch(keccak256("ranch:new"), 10, 0, 0, bytes32(0));
        vm.expectRevert(paused);
        ledger.registerSink(keccak256("sink:new"), 1);
        vm.expectRevert(paused);
        ledger.recordBirths(BREEDER, 1, 2026);
        vm.expectRevert(paused);
        ledger.recordDeaths(BREEDER, 1);
        vm.stopPrank();

        vm.expectRevert(paused);
        vm.prank(issuer);
        ledger.recordMovement(_gtaHash("GTA-P"), BREEDER, FATTENER, 1, 2, DATE);

        vm.expectRevert(paused);
        ledger.attestRisk(a, asig);
        vm.expectRevert(paused);
        ledger.issueCertificate(c, csig);
        vm.expectRevert(paused);
        vm.prank(oracle);
        ledger.anchorEvidence(EVIDENCE, BREEDER, bytes32(0), 1);
    }

    function test_Pause_BlocksConsumption() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(admin);
        ledger.pause();
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, REF);
    }

    function test_Pause_ProtectiveRegulatorActionsStillWork() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(admin);
        ledger.pause();
        vm.startPrank(regulator);
        ledger.setEmbargo(BREEDER, true, REASON);
        ledger.revokeCertificate(lot, REASON);
        vm.stopPrank();
        assertTrue(ledger.isEmbargoed(BREEDER));
        assertTrue(ledger.certificate(lot).revoked);
    }

    function test_Pause_OnlyPauserPausesOnlyAdminUnpauses() public {
        address guardian = makeAddr("guardian");
        vm.startPrank(admin);
        ledger.grantRole(ledger.PAUSER_ROLE(), guardian);
        vm.stopPrank();

        vm.expectRevert(_unauthorized(stranger, ledger.PAUSER_ROLE()));
        vm.prank(stranger);
        ledger.pause();

        vm.prank(guardian);
        ledger.pause();
        vm.expectRevert(_unauthorized(guardian, ledger.DEFAULT_ADMIN_ROLE()));
        vm.prank(guardian);
        ledger.unpause(); // a (possibly compromised) pauser cannot resume

        vm.prank(admin);
        ledger.unpause();
        assertFalse(ledger.paused());
        _move(_gtaHash("GTA-AFTER"), BREEDER, FATTENER, 10); // ledger works again
    }

    function test_Admin_RotatesACompromisedOracle() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c); // signed, not yet relayed
        bytes32 role = ledger.ORACLE_ROLE();
        vm.prank(admin);
        ledger.revokeRole(role, oracle);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, oracle));
        ledger.issueCertificate(c, sig);
    }

    // ------------------------------------------------------------------ timed embargoes

    function test_EmbargoUntil_BlocksThenExpires() public {
        uint64 until = uint64(block.timestamp) + 90 days;
        vm.expectEmit(address(ledger));
        emit IHerdLedger.EmbargoExpirySet(BREEDER, until, regulator);
        vm.prank(regulator);
        ledger.setEmbargoUntil(BREEDER, until, REASON);
        assertTrue(ledger.isEmbargoed(BREEDER));
        assertEq(ledger.ranch(BREEDER).embargoExpiresAt, until);
        assertEq(ledger.ranch(BREEDER).embargoedSince, block.timestamp);

        bytes32 h = _gtaHash("GTA-E1");
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, BREEDER));
        vm.prank(issuer);
        ledger.recordMovement(h, BREEDER, FATTENER, 5, 2, DATE);

        vm.warp(until); // expired: no further transaction needed
        assertFalse(ledger.isEmbargoed(BREEDER));
        _move(h, BREEDER, FATTENER, 5);
        assertEq(ledger.gta(h).head, 5);
    }

    function test_RevertWhen_EmbargoUntil_InThePast() public {
        uint64 past = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidValidity.selector, uint64(block.timestamp), past));
        vm.prank(regulator);
        ledger.setEmbargoUntil(BREEDER, past, REASON);
    }

    function test_EmbargoUntil_OnlyRegulator() public {
        uint64 until = uint64(block.timestamp) + 1 days;
        vm.expectRevert(_unauthorized(stranger, ledger.REGULATOR_ROLE()));
        vm.prank(stranger);
        ledger.setEmbargoUntil(BREEDER, until, REASON);
    }

    function test_SetEmbargo_MakesATimedEmbargoOpenEnded() public {
        vm.startPrank(regulator);
        ledger.setEmbargoUntil(BREEDER, uint64(block.timestamp) + 1 days, REASON);
        uint64 since = ledger.ranch(BREEDER).embargoedSince;
        vm.warp(block.timestamp + 1 hours);
        ledger.setEmbargo(BREEDER, true, keccak256("extended"));
        vm.stopPrank();
        assertEq(ledger.ranch(BREEDER).embargoExpiresAt, 0);
        assertEq(ledger.ranch(BREEDER).embargoedSince, since, "start time kept");
        vm.warp(block.timestamp + 30 days);
        assertTrue(ledger.isEmbargoed(BREEDER));
    }

    function test_Embargo_CorrectionIsAuditable() public {
        _embargo(BREEDER, true);
        bytes32 correction = keccak256("ibama:annulment:entered-in-error");
        vm.expectEmit(address(ledger));
        emit IHerdLedger.EmbargoSet(BREEDER, false, correction, regulator);
        vm.prank(regulator);
        ledger.setEmbargo(BREEDER, false, correction);
        assertFalse(ledger.isEmbargoed(BREEDER));
        assertEq(ledger.ranch(BREEDER).embargoReason, correction);
    }

    function test_ExpiredEmbargo_RestartsItsClockWhenReimposed() public {
        vm.startPrank(regulator);
        ledger.setEmbargoUntil(BREEDER, uint64(block.timestamp) + 1 days, REASON);
        vm.warp(block.timestamp + 2 days);
        ledger.setEmbargo(BREEDER, true, REASON);
        vm.stopPrank();
        assertEq(ledger.ranch(BREEDER).embargoedSince, block.timestamp);
    }

    // ------------------------------------------------------------------ evidence registry

    function test_AnchorEvidence_StoresRecordOnce() public {
        bytes32 uri = sha256("https://example.org/evidence/abc.json");
        vm.expectEmit(address(ledger));
        emit IHerdLedger.EvidenceAnchored(EVIDENCE, lot, uri, 1, oracle);
        vm.prank(oracle);
        ledger.anchorEvidence(EVIDENCE, lot, uri, 1);
        IHerdLedger.EvidenceRecord memory e = ledger.evidence(EVIDENCE);
        assertEq(e.subject, lot);
        assertEq(e.uriHash, uri);
        assertEq(e.schemaVersion, 1);
        assertEq(e.anchoredBy, oracle);
        assertEq(e.anchoredAt, block.timestamp);

        vm.expectRevert(_err(IHerdLedger.EvidenceAlreadyAnchored.selector, EVIDENCE));
        vm.prank(oracle);
        ledger.anchorEvidence(EVIDENCE, BREEDER, bytes32(0), 2);
    }

    function test_RevertWhen_AnchorEvidence_NotOracleOrZero() public {
        vm.expectRevert(_unauthorized(stranger, ledger.ORACLE_ROLE()));
        vm.prank(stranger);
        ledger.anchorEvidence(EVIDENCE, lot, bytes32(0), 1);
        vm.startPrank(oracle);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.ZeroId.selector));
        ledger.anchorEvidence(bytes32(0), lot, bytes32(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.ZeroId.selector));
        ledger.anchorEvidence(EVIDENCE, bytes32(0), bytes32(0), 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ oracle registry

    function test_OracleRegistry_ListsAuthorisedSigners() public {
        assertTrue(ledger.isOracle(oracle));
        assertFalse(ledger.isOracle(rogue));
        address[] memory list = ledger.oracles();
        assertEq(list.length, 1);
        assertEq(list[0], oracle);

        bytes32 role = ledger.ORACLE_ROLE();
        vm.startPrank(admin);
        ledger.grantRole(role, rogue);
        ledger.revokeRole(role, oracle);
        vm.stopPrank();
        list = ledger.oracles();
        assertEq(list.length, 1);
        assertEq(list[0], rogue);
        assertFalse(ledger.isOracle(oracle));
    }

    function test_Constructor_AdminCanPause() public view {
        assertTrue(ledger.hasRole(ledger.PAUSER_ROLE(), admin));
        assertFalse(ledger.paused());
    }

    // ------------------------------------------------------------------ helpers

    function _expectIssueRevert(IHerdLedger.Certificate memory c, bytes memory revertData) internal {
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectRevert(revertData);
        ledger.issueCertificate(c, sig);
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, v, r, s);
    }
}
