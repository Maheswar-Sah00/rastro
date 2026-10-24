// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHerdLedger} from "../../src/IHerdLedger.sol";
import {LedgerFixture} from "../utils/LedgerFixture.sol";

/// @notice Replays the committed pipeline fixture (`test/fixtures/chain_seed.sample.json`) through the
///         ledger inside the EVM, mirroring `replay/replay.mjs`: every seed event must be accepted, the
///         herd must be conserved, and the four demo attempts must fail with their specific errors.
contract SampleSeedReplayTest is LedgerFixture {
    string internal json;
    uint256 internal sinkHead;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/chain_seed.sample.json"));
    }

    function test_SampleSeed_EveryEventAcceptedAndHerdConserved() public {
        _replayAll();
        IHerdLedger.Totals memory t = ledger.totals();
        assertTrue(ledger.isConserved());
        assertEq(t.headToSinks, sinkHead, "head delivered to sinks");
        assertEq(t.ranches, _len(".ranches"));
        assertEq(t.sinks, _len(".sinks"));
        assertEq(t.certificates, _len(".certificates"));

        uint256 sum;
        uint256 nRanches = _len(".ranches");
        for (uint256 i = 0; i < nRanches; ++i) {
            sum += ledger.balanceOf(_b32(string.concat(".ranches[", vm.toString(i), "].onchain_id")));
        }
        assertEq(sum, t.ranchHead, "sum of ranch balances");
    }

    function test_SampleSeed_CleanCertificateConsumedOnceThenRefused() public {
        _replayAll();
        bytes32 lot = _b32(".demo.consume_clean");
        vm.prank(buyer);
        ledger.consumeCertificate(lot, 1, keccak256("EUDR-DDS"));
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.Consumed));

        vm.expectRevert(_err(IHerdLedger.CertificateAlreadyUsed.selector, _b32(".demo.double_consume")));
        vm.prank(buyer2);
        ledger.consumeCertificate(_b32(".demo.double_consume"), 0, keccak256("second claim"));
    }

    function test_SampleSeed_FlaggedCertificateRefused() public {
        _replayAll();
        bytes32 lot = _b32(".demo.consume_flagged");
        assertEq(uint8(ledger.certificateStatus(lot)), uint8(IHerdLedger.CertificateStatus.NotClean));
        vm.expectRevert(_err(IHerdLedger.CertificateNotClean.selector, lot));
        _consume(lot);
    }

    function test_SampleSeed_EmbargoedOriginRefused() public {
        _replayAll();
        string memory p = ".demo.embargoed_attempt";
        bytes32 from = _b32(string.concat(p, ".from"));
        assertTrue(ledger.ranch(from).embargoed);
        vm.expectRevert(_err(IHerdLedger.OriginEmbargoed.selector, from));
        vm.prank(issuer);
        ledger.recordMovement(
            _b32(string.concat(p, ".hash")),
            from,
            _b32(string.concat(p, ".to")),
            uint32(_uint(string.concat(p, ".head"))),
            uint8(_uint(string.concat(p, ".purpose"))),
            uint64(_uint(string.concat(p, ".date_unix")))
        );
    }

    function test_SampleSeed_PhantomBirthsRefused() public {
        _replayAll();
        string memory p = ".demo.phantom_births_attempt";
        bytes32 r = _b32(string.concat(p, ".ranch"));
        uint32 head = uint32(_uint(string.concat(p, ".head")));
        uint16 year = uint16(_uint(string.concat(p, ".year")));
        uint256 max = (uint256(ledger.ranch(r).breedingCows) * 8500) / 10_000;
        uint256 total = uint256(ledger.birthsInYear(r, year)) + head;
        vm.expectRevert(abi.encodeWithSelector(IHerdLedger.BirthsExceedBiology.selector, r, year, total, max));
        _births(r, head, year);
    }

    // ------------------------------------------------------------------ replay

    function _replayAll() internal {
        vm.startPrank(registrar);
        uint256 nSinks = _len(".sinks");
        for (uint256 i = 0; i < nSinks; ++i) {
            string memory p = string.concat(".sinks[", vm.toString(i), "]");
            ledger.registerSink(
                _b32(string.concat(p, ".onchain_id")), uint8(_uint(string.concat(p, ".kind")))
            );
        }
        uint256 nRanches = _len(".ranches");
        for (uint256 i = 0; i < nRanches; ++i) {
            string memory p = string.concat(".ranches[", vm.toString(i), "]");
            ledger.registerRanch(
                _b32(string.concat(p, ".onchain_id")),
                uint32(_uint(string.concat(p, ".capacity_head"))),
                uint32(_uint(string.concat(p, ".initial_head"))),
                uint32(_uint(string.concat(p, ".breeding_cows"))),
                _b32(string.concat(p, ".geom_hash"))
            );
        }
        vm.stopPrank();

        uint256 nEvents = _len(".events");
        for (uint256 i = 0; i < nEvents; ++i) {
            _applyEvent(string.concat(".events[", vm.toString(i), "]"));
        }

        uint256 nRiskAttestations = _len(".risk_attestations");
        for (uint256 i = 0; i < nRiskAttestations; ++i) {
            string memory p = string.concat(".risk_attestations[", vm.toString(i), "]");
            IHerdLedger.RiskAttestation memory a = IHerdLedger.RiskAttestation({
                ranch: _b32(string.concat(p, ".ranch")),
                riskClass: uint8(_uint(string.concat(p, ".risk_class"))),
                scoreBps: uint16(_uint(string.concat(p, ".score_bps"))),
                evidenceHash: _b32(string.concat(p, ".evidence_hash")),
                asOf: uint64(_uint(string.concat(p, ".as_of"))),
                nonce: i + 1
            });
            _attest(a);
        }

        uint256 nCertificates = _len(".certificates");
        for (uint256 i = 0; i < nCertificates; ++i) {
            string memory p = string.concat(".certificates[", vm.toString(i), "]");
            IHerdLedger.Certificate memory c = IHerdLedger.Certificate({
                lotId: _b32(string.concat(p, ".lot_id")),
                sink: _b32(string.concat(p, ".sink")),
                gtaHashes: vm.parseJsonBytes32Array(json, string.concat(p, ".gta_hashes")),
                // Same commitment the replay uses: SHA-256 of the pipeline salt and the shipment id.
                shipment: sha256(
                    abi.encodePacked("rastro-demo-salt-v1|", vm.parseJsonString(json, string.concat(p, ".shipment")))
                ),
                head: uint32(_uint(string.concat(p, ".head"))),
                verdict: uint8(_uint(string.concat(p, ".verdict"))),
                evidenceHash: _b32(string.concat(p, ".evidence_hash")),
                issuedAt: uint64(block.timestamp),
                expiresAt: uint64(block.timestamp) + 365 days,
                policyVersion: 1,
                nonce: 1_000_000 + i
            });
            _issue(c);
        }
    }

    function _applyEvent(string memory p) internal {
        bytes32 kind = keccak256(bytes(vm.parseJsonString(json, string.concat(p, ".type"))));
        if (kind == keccak256("movement")) {
            uint32 head = uint32(_uint(string.concat(p, ".head")));
            bytes32 to = _b32(string.concat(p, ".to"));
            vm.prank(issuer);
            ledger.recordMovement(
                _b32(string.concat(p, ".hash")),
                _b32(string.concat(p, ".from")),
                to,
                head,
                uint8(_uint(string.concat(p, ".purpose"))),
                uint64(_uint(string.concat(p, ".date_unix")))
            );
            if (ledger.entityType(to) == IHerdLedger.EntityType.Sink) sinkHead += head;
        } else if (kind == keccak256("births")) {
            _births(
                _b32(string.concat(p, ".ranch")),
                uint32(_uint(string.concat(p, ".head"))),
                uint16(_uint(string.concat(p, ".year")))
            );
        } else if (kind == keccak256("deaths")) {
            _deaths(_b32(string.concat(p, ".ranch")), uint32(_uint(string.concat(p, ".head"))));
        } else if (kind == keccak256("embargo")) {
            vm.prank(regulator);
            ledger.setEmbargo(_b32(string.concat(p, ".ranch")), true, _b32(string.concat(p, ".reason_hash")));
        } else {
            revert("unknown event type");
        }
    }

    // ------------------------------------------------------------------ json helpers

    function _len(string memory arrayPath) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(arrayPath, "[", vm.toString(n), "]"))) ++n;
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function _uint(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }
}
