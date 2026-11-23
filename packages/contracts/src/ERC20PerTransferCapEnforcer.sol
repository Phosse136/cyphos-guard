// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ExecutionLib } from "@erc7579/lib/ExecutionLib.sol";
import { CaveatEnforcer } from "@delegator/src/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/src/utils/Types.sol";

/**
 * @title ERC20PerTransferCapEnforcer
 * @notice Caps the amount of EVERY single ERC-20 transfer made under a delegation. Stateless: unlike
 *         ERC20TransferAmountEnforcer there is no running total; that is the job of a period enforcer
 *         (e.g. ERC20PeriodTransferEnforcer) placed next to it.
 *
 * The execution must be exactly `token.transfer(to, amount)` with `amount <= maxAmount`:
 * - single-call, default-execution mode only (a batch could otherwise hide a second transfer),
 * - target == token, value == 0,
 * - calldata is exactly 68 bytes and starts with the transfer() selector (so approve(), transferFrom() or
 *   anything else is rejected, not just "checked at the wrong offset").
 *
 * These pins are deliberately repeated here even though ERC20PeriodTransferEnforcer enforces the same, so the
 * cap stays sound when this enforcer is used on its own.
 *
 * terms: abi.encodePacked(address token, uint256 maxAmount)   (52 bytes)
 */
contract ERC20PerTransferCapEnforcer is CaveatEnforcer {
    using ExecutionLib for bytes;

    function beforeHook(
        bytes calldata _terms,
        bytes calldata,
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32,
        address,
        address
    )
        public
        pure
        override
        onlySingleCallTypeMode(_mode)
        onlyDefaultExecutionMode(_mode)
    {
        (address token_, uint256 maxAmount_) = getTermsInfo(_terms);
        (address target_, uint256 value_, bytes calldata callData_) = _executionCallData.decodeSingle();

        require(target_ == token_, "ERC20PerTransferCapEnforcer:invalid-contract");
        require(value_ == 0, "ERC20PerTransferCapEnforcer:invalid-value");
        require(callData_.length == 68, "ERC20PerTransferCapEnforcer:invalid-execution-length");
        require(bytes4(callData_[0:4]) == IERC20.transfer.selector, "ERC20PerTransferCapEnforcer:invalid-method");
        require(uint256(bytes32(callData_[36:68])) <= maxAmount_, "ERC20PerTransferCapEnforcer:amount-exceeded");
    }

    /// @notice Decodes the terms: the token and the maximum amount of a single transfer.
    function getTermsInfo(bytes calldata _terms) public pure returns (address token_, uint256 maxAmount_) {
        require(_terms.length == 52, "ERC20PerTransferCapEnforcer:invalid-terms-length");
        token_ = address(bytes20(_terms[0:20]));
        maxAmount_ = uint256(bytes32(_terms[20:52]));
    }
}
