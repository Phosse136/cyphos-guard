// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import {
    ModeLib,
    CALLTYPE_SINGLE,
    EXECTYPE_TRY,
    MODE_DEFAULT,
    ModePayload
} from "@erc7579/lib/ModeLib.sol";
import { ModeCode } from "@delegator/src/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";
import { CosignerEnforcer } from "../src/CosignerEnforcer.sol";

/// @dev Unit tests: this test contract plays the DelegationManager (msg.sender of the hook).
///      The end-to-end path through the deployed DelegationManager is covered by the SDK fork tests.
contract CosignerEnforcerTest is Test {
    CosignerEnforcer internal enforcer;
    uint256 internal cosignerKey = 0xC0516;
    address internal cosigner;
    address internal redeemer = address(0xA6E);
    bytes32 internal delegationHash = keccak256("delegation");
    ModeCode internal singleDefault = ModeLib.encodeSimpleSingle();
    bytes internal execution;

    event Cosigned(
        address indexed delegationManager, bytes32 indexed delegationHash, address indexed cosigner, bytes32 digest
    );

    function setUp() public {
        enforcer = new CosignerEnforcer();
        cosigner = vm.addr(cosignerKey);
        execution = ExecutionLib.encodeSingle(address(0xB0B), 1 ether, hex"");
        vm.warp(1_800_000_000);
    }

    function _args(
        uint256 key,
        address dm,
        bytes32 dHash,
        address red,
        bytes memory exec,
        bytes32 salt,
        uint256 deadline
    )
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = enforcer.getCosignDigest(dm, dHash, red, keccak256(exec), salt, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(salt, deadline, abi.encodePacked(r, s, v));
    }

    function _valid(bytes32 salt) internal view returns (bytes memory) {
        return _args(cosignerKey, address(this), delegationHash, redeemer, execution, salt, block.timestamp + 300);
    }

    function _hook(bytes memory terms, bytes memory args, ModeCode mode, bytes memory exec, address red) internal {
        enforcer.beforeHook(terms, args, mode, exec, delegationHash, address(0xDE1), red);
    }

    function test_validCosignaturePassesAndIsConsumed() public {
        bytes memory args = _valid(bytes32(uint256(1)));
        bytes32 digest = enforcer.getCosignDigest(
            address(this), delegationHash, redeemer, keccak256(execution), bytes32(uint256(1)), block.timestamp + 300
        );
        vm.expectEmit(true, true, true, true, address(enforcer));
        emit Cosigned(address(this), delegationHash, cosigner, digest);
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
        assertTrue(enforcer.usedCosignatures(address(this), digest));
    }

    function test_replayIsRejected() public {
        bytes memory args = _valid(bytes32(uint256(2)));
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
        vm.expectRevert("CosignerEnforcer:already-used");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
    }

    function test_freshSaltAllowsSameExecutionAgain() public {
        _hook(abi.encodePacked(cosigner), _valid(bytes32(uint256(3))), singleDefault, execution, redeemer);
        _hook(abi.encodePacked(cosigner), _valid(bytes32(uint256(4))), singleDefault, execution, redeemer);
    }

    function test_wrongSignerIsRejected() public {
        bytes memory args =
            _args(0xBAD, address(this), delegationHash, redeemer, execution, bytes32(0), block.timestamp + 300);
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
    }

    function test_differentExecutionIsRejected() public {
        bytes memory args = _valid(bytes32(0));
        bytes memory other = ExecutionLib.encodeSingle(address(0xB0B), 2 ether, hex"");
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(cosigner), args, singleDefault, other, redeemer);
    }

    function test_differentRedeemerIsRejected() public {
        bytes memory args = _valid(bytes32(0));
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, address(0xEE1));
    }

    function test_differentDelegationIsRejected() public {
        bytes memory args =
            _args(cosignerKey, address(this), keccak256("other"), redeemer, execution, bytes32(0), block.timestamp + 300);
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
    }

    function test_cosignatureForAnotherDelegationManagerIsRejected() public {
        bytes memory args =
            _args(cosignerKey, address(0xD0), delegationHash, redeemer, execution, bytes32(0), block.timestamp + 300);
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
    }

    function test_cosignerMismatchInTermsIsRejected() public {
        bytes memory args = _valid(bytes32(0));
        vm.expectRevert("CosignerEnforcer:invalid-cosignature");
        _hook(abi.encodePacked(address(0xC0FFEE)), args, singleDefault, execution, redeemer);
    }

    function test_expiredIsRejected() public {
        bytes memory args = _valid(bytes32(0));
        vm.warp(block.timestamp + 301);
        vm.expectRevert("CosignerEnforcer:expired");
        _hook(abi.encodePacked(cosigner), args, singleDefault, execution, redeemer);
    }

    function test_batchAndTryModesAreRejected() public {
        bytes memory args = _valid(bytes32(0));
        vm.expectRevert("CaveatEnforcer:invalid-call-type");
        _hook(abi.encodePacked(cosigner), args, ModeLib.encodeSimpleBatch(), execution, redeemer);
        vm.expectRevert("CaveatEnforcer:invalid-execution-type");
        ModeCode singleTry = ModeLib.encode(CALLTYPE_SINGLE, EXECTYPE_TRY, MODE_DEFAULT, ModePayload.wrap(0x00));
        _hook(abi.encodePacked(cosigner), args, singleTry, execution, redeemer);
    }

    function test_badTermsAreRejected() public {
        bytes memory args = _valid(bytes32(0));
        vm.expectRevert("CosignerEnforcer:invalid-terms-length");
        _hook(abi.encodePacked(cosigner, uint8(1)), args, singleDefault, execution, redeemer);
        vm.expectRevert("CosignerEnforcer:zero-cosigner");
        _hook(abi.encodePacked(address(0)), args, singleDefault, execution, redeemer);
    }

    function test_missingOrGarbageArgsRevert() public {
        vm.expectRevert("CosignerEnforcer:missing-cosignature");
        _hook(abi.encodePacked(cosigner), hex"", singleDefault, execution, redeemer);
        vm.expectRevert();
        _hook(abi.encodePacked(cosigner), hex"deadbeef", singleDefault, execution, redeemer);
    }

    function testFuzz_anyExecutionWithMatchingCosignaturePasses(address target, uint96 value, bytes calldata data)
        public
    {
        bytes memory exec = ExecutionLib.encodeSingle(target, value, data);
        bytes memory args =
            _args(cosignerKey, address(this), delegationHash, redeemer, exec, bytes32(0), block.timestamp + 60);
        _hook(abi.encodePacked(cosigner), args, singleDefault, exec, redeemer);
    }
}
