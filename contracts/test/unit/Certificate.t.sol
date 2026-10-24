// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice issueCertificate, consumeCertificate, revokeCertificate, certificateStatus.
contract CertificateTest is LedgerFixture {
    bytes32 internal g1;
    bytes32 internal g2;
    bytes32 internal lot = keccak256("lot:SHP-0007");
    bytes32 internal constant DDS = keccak256("EUDR-DDS-2026-000042");

    function setUp() public override {
        super.setUp();
        (g1, g2) = _worldWithDeliveries(); // g1: 300 head, g2: 200 head, both into SLAUGHTERHOUSE
    }

    // ------------------------------------------------------------------ issue: happy paths

    function test_IssueCertificate_StoresRecordAndBindsGtas() public {
        vm.warp(1_760_000_000);
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 500, 0));

        IHerdLedger.CertificateRecord memory c = ledger.certificate(lot);
        assertTrue(c.issued);
        assertEq(c.sink, SLAUGHTERHOUSE);
        assertEq(c.head, 500);
        assertEq(c.verdict, 0);
        assertEq(c.evidenceHash, EVIDENCE);
        assertEq(c.oracle, oracle);
        assertEq(c.issuedAt, 1_760_000_000);
        assertFalse(c.consumed);
        assertFalse(c.revoked);

        bytes32[] memory gtas = ledger.certificateGtas(lot);
        assertEq(gtas.length, 2);
        assertEq(gtas[0], g1);
        assertEq(gtas[1], g2);
        assertEq(ledger.gta(g1).lotId, lot);
        assertEq(ledger.gta(g2).lotId, lot);
        assertEq(ledger.totals().certificates, 1);
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Valid));
    }

    function test_IssueCertificate_EmitsEvent() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1);
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CertificateIssued(lot, SLAUGHTERHOUSE, 300, 1, EVIDENCE, _list(g1), oracle, c.nonce);
        ledger.issueCertificate(c, sig);
    }

    function test_IssueCertificate_RelayableByAnyAccount() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c);
        vm.prank(stranger);
        ledger.issueCertificate(c, sig);
        assertTrue(ledger.certificate(lot).issued);
    }

    function test_IssueCertificate_HeadMayBeLessThanGtas() public {
        // Part of the delivery condemned at the slaughterhouse: the lot is smaller than the GTAs.
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 499, 0));
        assertEq(ledger.certificate(lot).head, 499);
    }

    function test_IssueCertificate_FlaggedVerdictBurnsGtasForLaterCleanLots() public {
        // Shopping for a better verdict: once flagged, the same GTAs cannot back a "clean" lot.
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1));
        bytes32 lot2 = keccak256("lot:SHP-0008");
        IHerdLedger.Certificate memory c = _cert(lot2, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, g1, lot));
        ledger.issueCertificate(c, sig);
    }

    function test_IssueCertificate_MaxGtasPerCertificate() public {
        uint256 max = ledger.MAX_GTAS_PER_CERTIFICATE();
        bytes32[] memory many = new bytes32[](max);
        for (uint256 i = 0; i < max; ++i) {
            many[i] = keccak256(abi.encode("bulk", i));
            _move(many[i], FATTENER, PORT, 1);
        }
        _issue(_cert(lot, PORT, many, uint32(max), 0));
        assertEq(ledger.certificateGtas(lot).length, max);
    }

    function test_HashCertificate_MatchesIndependentEip712Encoding() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 500, 2);
        assertEq(ledger.hashCertificate(c), _certDigest(c, address(ledger)));
    }

    function test_HashCertificate_GtaOrderIsSigned() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 500, 0);
        bytes32 forward = ledger.hashCertificate(c);
        c.gtaHashes = _list(g2, g1);
        assertTrue(forward != ledger.hashCertificate(c));
    }

    // ------------------------------------------------------------------ issue: reverts

    function test_RevertWhen_IssueCertificate_ZeroLotId() public {
        _expectIssueRevert(
            _cert(bytes32(0), SLAUGHTERHOUSE, _list(g1), 300, 0),
            abi.encodeWithSelector(IHerdLedger.ZeroId.selector)
        );
    }

    function test_RevertWhen_IssueCertificate_AlreadyIssued() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g2), 200, 0),
            _err(IHerdLedger.CertificateAlreadyIssued.selector, lot)
        );
    }

    function test_RevertWhen_IssueCertificate_UnknownSink() public {
        _expectIssueRevert(
            _cert(lot, UNKNOWN, _list(g1), 300, 0), _err(IHerdLedger.UnknownEntity.selector, UNKNOWN)
        );
    }

    function test_RevertWhen_IssueCertificate_SinkIsARanch() public {
        _expectIssueRevert(
            _cert(lot, FATTENER, _list(g1), 300, 0), _err(IHerdLedger.NotASink.selector, FATTENER)
        );
    }

    function test_RevertWhen_IssueCertificate_InvalidVerdict() public {
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 4),
            abi.encodeWithSelector(IHerdLedger.InvalidVerdict.selector, uint8(4))
        );
    }

    function test_RevertWhen_IssueCertificate_NoGtas() public {
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, new bytes32[](0), 1, 0),
            _err(IHerdLedger.EmptyCertificate.selector, lot)
        );
    }

    function test_RevertWhen_IssueCertificate_TooManyGtas() public {
        uint256 max = ledger.MAX_GTAS_PER_CERTIFICATE();
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, new bytes32[](max + 1), 1, 0),
            abi.encodeWithSelector(IHerdLedger.TooManyGtas.selector, max + 1, max)
        );
    }

    function test_RevertWhen_IssueCertificate_ZeroHead() public {
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1), 0, 0), abi.encodeWithSelector(IHerdLedger.ZeroHead.selector)
        );
    }

    function test_RevertWhen_IssueCertificate_UnknownGta() public {
        bytes32 ghost = _gtaHash("GTA-NEVER-ISSUED");
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1, ghost), 300, 0), _err(IHerdLedger.UnknownGta.selector, ghost)
        );
    }

    function test_RevertWhen_IssueCertificate_GtaDeliveredToAnotherSink() public {
        bytes32 g3 = _gtaHash("GTA-PORT");
        _move(g3, FATTENER, PORT, 10);
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1, g3), 300, 0),
            abi.encodeWithSelector(IHerdLedger.GtaDestinationMismatch.selector, g3, PORT, SLAUGHTERHOUSE)
        );
    }

    function test_RevertWhen_IssueCertificate_GtaBetweenRanches() public {
        bytes32 g3 = _gtaHash("GTA-RANCH");
        _move(g3, BREEDER, MIDDLEMAN, 10);
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g3), 10, 0),
            abi.encodeWithSelector(IHerdLedger.GtaDestinationMismatch.selector, g3, MIDDLEMAN, SLAUGHTERHOUSE)
        );
    }

    function test_RevertWhen_IssueCertificate_GtaAlreadyInAnotherCertificate() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        bytes32 lot2 = keccak256("lot:SHP-0012");
        _expectIssueRevert(
            _cert(lot2, SLAUGHTERHOUSE, _list(g2, g1), 500, 0),
            abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, g1, lot)
        );
    }

    function test_RevertWhen_IssueCertificate_GtaListedTwice() public {
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1, g1), 600, 0),
            abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, g1, lot)
        );
    }

    function test_RevertWhen_IssueCertificate_HeadExceedsGtas() public {
        _expectIssueRevert(
            _cert(lot, SLAUGHTERHOUSE, _list(g1, g2), 501, 0),
            abi.encodeWithSelector(IHerdLedger.CertificateHeadExceedsGtas.selector, lot, 501, 500)
        );
    }

    function test_RevertWhen_IssueCertificate_SignerNotOracle() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(roguePk, c);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidSigner.selector, rogue));
        ledger.issueCertificate(c, sig);
    }

    function test_RevertWhen_IssueCertificate_NonceReusedForAnotherLot() public {
        IHerdLedger.Certificate memory c1 = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        _issue(c1);
        IHerdLedger.Certificate memory c2 = _cert(keccak256("lot:2"), SLAUGHTERHOUSE, _list(g2), 200, 0);
        c2.nonce = c1.nonce;
        bytes memory sig = _signCert(oraclePk, c2);
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.NonceAlreadyUsed.selector, oracle, c1.nonce));
        ledger.issueCertificate(c2, sig);
    }

    function test_RevertWhen_IssueCertificate_VerdictTamperedAfterSigning() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1); // flagged
        bytes memory sig = _signCert(oraclePk, c);
        c.verdict = 0; // relayer rewrites it as clean
        vm.expectRevert(); // recovers some unrelated address -> InvalidSigner(<that address>)
        ledger.issueCertificate(c, sig);
        assertFalse(ledger.certificate(lot).issued);
    }

    function test_RevertWhen_IssueCertificate_GtaListTamperedAfterSigning() public {
        IHerdLedger.Certificate memory c = _cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0);
        bytes memory sig = _signCert(oraclePk, c);
        c.gtaHashes = _list(g2); // swap in a different delivery
        vm.expectRevert();
        ledger.issueCertificate(c, sig);
        assertEq(ledger.gta(g2).lotId, bytes32(0));
    }

    // ------------------------------------------------------------------ consume

    function test_ConsumeCertificate_Clean() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.warp(block.timestamp + 30 days);
        uint256 consumedAt = block.timestamp;
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 1, DDS);
        IHerdLedger.CertificateRecord memory c = ledger.certificate(lot);
        assertTrue(c.consumed);
        assertEq(c.use, 1);
        assertEq(c.consumedBy, buyer);
        assertEq(c.consumedAt, consumedAt);
        assertEq(c.consumeRef, DDS);
        assertEq(ledger.totals().consumed, 1);
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Consumed));
    }

    function test_ConsumeCertificate_EmitsEvent() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CertificateConsumed(lot, 0, DDS, buyer);
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, DDS);
    }

    function test_ConsumeCertificate_EveryUseType() public {
        for (uint8 use = 0; use <= 2; ++use) {
            bytes32 h = keccak256(abi.encode("use", use));
            bytes32 l = keccak256(abi.encode("lot", use));
            _move(h, FATTENER, PORT, 1);
            _issue(_cert(l, PORT, _list(h), 1, 0));
            vm.prank(buyer);
            ledger.consumeCertificate(l, use, DDS);
            assertEq(ledger.certificate(l).use, use);
        }
    }

    function test_RevertWhen_ConsumeCertificate_Twice() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        _consume(lot);
        vm.expectRevert(_err(IHerdLedger.CertificateAlreadyUsed.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_SecondBuyerReusesPaperwork() public {
        // The same clean lot cannot back both a Turkish import and an EU due-diligence statement.
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 0, keccak256("TR-shipment"));
        vm.expectRevert(_err(IHerdLedger.CertificateAlreadyUsed.selector, lot));
        vm.prank(buyer2);
        ledger.consumeCertificate(lot, 1, DDS);
    }

    function test_RevertWhen_ConsumeCertificate_Flagged() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1));
        vm.expectRevert(_err(IHerdLedger.CertificateNotClean.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_UnknownVerdict() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 2));
        vm.expectRevert(_err(IHerdLedger.CertificateNotClean.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_Revoked() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        vm.expectRevert(_err(IHerdLedger.CertificateRevoked.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_ConsumedThenRevoked() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        _consume(lot);
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        vm.expectRevert(_err(IHerdLedger.CertificateRevoked.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_UnknownLot() public {
        vm.expectRevert(_err(IHerdLedger.UnknownCertificate.selector, lot));
        _consume(lot);
    }

    function test_RevertWhen_ConsumeCertificate_InvalidUse() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.InvalidUse.selector, uint8(3)));
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 3, DDS);
    }

    function test_RevertWhen_ConsumeCertificate_CallerNotBuyer() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectRevert(_unauthorized(oracle, ledger.BUYER_ROLE()));
        vm.prank(oracle);
        ledger.consumeCertificate(lot, 0, DDS);
    }

    // ------------------------------------------------------------------ revoke

    function test_RevokeCertificate_StoresReasonAndStatus() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        IHerdLedger.CertificateRecord memory c = ledger.certificate(lot);
        assertTrue(c.revoked);
        assertEq(c.revokeReason, REASON);
        assertEq(ledger.totals().revoked, 1);
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Revoked));
    }

    function test_RevokeCertificate_EmitsEvent() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectEmit(address(ledger));
        emit IHerdLedger.CertificateRevocation(lot, REASON, regulator);
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
    }

    function test_RevokeCertificate_AfterConsumptionKeepsConsumedFlag() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        _consume(lot);
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        IHerdLedger.CertificateRecord memory c = ledger.certificate(lot);
        assertTrue(c.consumed && c.revoked);
    }

    function test_RevokeCertificate_GtasStayBound() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        assertEq(ledger.gta(g1).lotId, lot);
        _expectIssueRevert(
            _cert(keccak256("lot:retry"), SLAUGHTERHOUSE, _list(g1), 300, 0),
            abi.encodeWithSelector(IHerdLedger.GtaAlreadyCertified.selector, g1, lot)
        );
    }

    function test_RevokeCertificate_FlaggedLot() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1));
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Revoked));
    }

    function test_RevertWhen_RevokeCertificate_Unknown() public {
        vm.expectRevert(_err(IHerdLedger.UnknownCertificate.selector, lot));
        vm.prank(regulator);
        ledger.revokeCertificate(lot, REASON);
    }

    function test_RevertWhen_RevokeCertificate_Twice() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.startPrank(regulator);
        ledger.revokeCertificate(lot, REASON);
        vm.expectRevert(_err(IHerdLedger.CertificateRevoked.selector, lot));
        ledger.revokeCertificate(lot, REASON);
        vm.stopPrank();
    }

    function test_RevertWhen_RevokeCertificate_CallerNotRegulator() public {
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 0));
        vm.expectRevert(_unauthorized(buyer, ledger.REGULATOR_ROLE()));
        vm.prank(buyer);
        ledger.revokeCertificate(lot, REASON);
    }

    // ------------------------------------------------------------------ status

    function test_CertificateStatus_AllStates() public {
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.None));
        _issue(_cert(lot, SLAUGHTERHOUSE, _list(g1), 300, 1));
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.NotClean));
        bytes32 lot2 = keccak256("lot:2");
        _issue(_cert(lot2, SLAUGHTERHOUSE, _list(g2), 200, 0));
        assertEq(uint8(ledger.certificateStatus(lot2)), uint8(IHerdLedger.CertificateStatus.Valid));
        _consume(lot2);
        assertEq(uint8(ledger.certificateStatus(lot2)), uint8(IHerdLedger.CertificateStatus.Consumed));
        vm.prank(regulator);
        ledger.revokeCertificate(lot2, REASON);
        assertEq(uint8(ledger.certificateStatus(lot2)), uint8(IHerdLedger.CertificateStatus.Revoked));
    }

    // ------------------------------------------------------------------ helpers

    function _expectIssueRevert(IHerdLedger.Certificate memory c, bytes memory revertData) internal {
        bytes memory sig = _signCert(oraclePk, c);
        vm.expectRevert(revertData);
        ledger.issueCertificate(c, sig);
    }
}
