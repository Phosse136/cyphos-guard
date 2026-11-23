// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { ModeLib, CALLTYPE_SINGLE, CALLTYPE_BATCH, EXECTYPE_TRY, EXECTYPE_DEFAULT, MODE_DEFAULT, ModePayload } from
    "@erc7579/lib/ModeLib.sol";
import { ModeCode, Execution } from "@delegator/src/utils/Types.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20PerTransferCapEnforcer } from "../src/ERC20PerTransferCapEnforcer.sol";

/// @dev Unit tests of the hook. The end-to-end path through the deployed DelegationManager is covered by the
///      SDK fork tests.
contract ERC20PerTransferCapEnforcerTest is Test {
    ERC20PerTransferCapEnforcer internal enforcer;
    address internal token = address(0x7070);
    address internal to = address(0xB0B);
    uint256 internal cap = 2_000_000; // 2 USDC
    bytes internal terms;
    ModeCode internal single = ModeLib.encodeSimpleSingle();

    function setUp() public {
        enforcer = new ERC20PerTransferCapEnforcer();
        terms = abi.encodePacked(token, cap);
    }

    function _transfer(uint256 amount) internal view returns (bytes memory) {
        return ExecutionLib.encodeSingle(token, 0, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _hook(bytes memory t, ModeCode mode, bytes memory exec) internal view {
        enforcer.beforeHook(t, hex"", mode, exec, bytes32(0), address(0), address(0));
    }

    function test_allowsUpToTheCap() public view {
        _hook(terms, single, _transfer(cap));
        _hook(terms, single, _transfer(1));
        _hook(terms, single, _transfer(0));
    }

    function test_rejectsAboveTheCap() public {
        vm.expectRevert("ERC20PerTransferCapEnforcer:amount-exceeded");
        _hook(terms, single, _transfer(cap + 1));
    }

    function testFuzz_capHolds(uint256 amount) public {
        if (amount > cap) vm.expectRevert("ERC20PerTransferCapEnforcer:amount-exceeded");
        _hook(terms, single, _transfer(amount));
    }

    function test_rejectsApprove() public {
        bytes memory exec = ExecutionLib.encodeSingle(token, 0, abi.encodeCall(IERC20.approve, (to, 1)));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-method");
        _hook(terms, single, exec);
    }

    function test_rejectsTransferFrom() public {
        // 100 bytes, so the length pin catches it before the selector check.
        bytes memory exec =
            ExecutionLib.encodeSingle(token, 0, abi.encodeCall(IERC20.transferFrom, (address(this), to, 1)));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-execution-length");
        _hook(terms, single, exec);
    }

    function test_rejectsOtherSelectorWithSameLength() public {
        // Same shape as transfer(address,uint256), different function: the amount word must not be trusted.
        bytes memory data = abi.encodeWithSignature("burnFrom(address,uint256)", to, 1);
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-method");
        _hook(terms, single, ExecutionLib.encodeSingle(token, 0, data));
    }

    function test_rejectsTrailingBytes() public {
        bytes memory data = abi.encodePacked(abi.encodeCall(IERC20.transfer, (to, 1)), uint256(cap * 10));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-execution-length");
        _hook(terms, single, ExecutionLib.encodeSingle(token, 0, data));
    }

    function test_rejectsOtherToken() public {
        bytes memory exec = ExecutionLib.encodeSingle(address(0xBAD), 0, abi.encodeCall(IERC20.transfer, (to, 1)));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-contract");
        _hook(terms, single, exec);
    }

    function test_rejectsValue() public {
        bytes memory exec = ExecutionLib.encodeSingle(token, 1, abi.encodeCall(IERC20.transfer, (to, 1)));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-value");
        _hook(terms, single, exec);
    }

    function test_rejectsBatchMode() public {
        // Two transfers under the cap each would still be one execution of the delegation: not allowed.
        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(token, 0, abi.encodeCall(IERC20.transfer, (to, cap)));
        calls[1] = Execution(token, 0, abi.encodeCall(IERC20.transfer, (to, cap)));
        ModeCode batch = ModeLib.encode(CALLTYPE_BATCH, EXECTYPE_DEFAULT, MODE_DEFAULT, ModePayload.wrap(0x00));
        vm.expectRevert("CaveatEnforcer:invalid-call-type");
        _hook(terms, batch, ExecutionLib.encodeBatch(calls));
    }

    function test_rejectsTryMode() public {
        ModeCode tryMode = ModeLib.encode(CALLTYPE_SINGLE, EXECTYPE_TRY, MODE_DEFAULT, ModePayload.wrap(0x00));
        vm.expectRevert("CaveatEnforcer:invalid-execution-type");
        _hook(terms, tryMode, _transfer(1));
    }

    function test_rejectsBadTerms() public {
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-terms-length");
        _hook(abi.encodePacked(token), single, _transfer(1));
        vm.expectRevert("ERC20PerTransferCapEnforcer:invalid-terms-length");
        _hook(abi.encode(token, cap), single, _transfer(1));
    }

    function test_getTermsInfo() public {
        (address t, uint256 m) = enforcer.getTermsInfo(terms);
        assertEq(t, token);
        assertEq(m, cap);
    }
}
