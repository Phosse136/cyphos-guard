// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { Vm } from "forge-std/Vm.sol";
import { ModeCode } from "@delegator/src/utils/Types.sol";
import { ModeLib } from "@erc7579/lib/ModeLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20PerTransferCapEnforcer } from "../src/ERC20PerTransferCapEnforcer.sol";
import { X402Vault } from "../src/X402Vault.sol";

contract SymbolicDomainToken {
    bytes32 public constant DOMAIN_SEPARATOR = keccak256("symbolic-domain");
}

/// @title Symbolic proofs (Halmos): `halmos --contract SymbolicProofs` (see docs/security/verification.md).
/// @dev `check_` functions are not run by `forge test`; Halmos explores ALL inputs, not samples. Each one states a
///      property the product's on-chain guarantee rests on.
contract SymbolicProofs {
    // Only the cheatcodes Halmos supports (forge-std's Test pulls in others in its own setup).
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ERC20PerTransferCapEnforcer internal enforcer;
    X402Vault internal vault;
    SymbolicDomainToken internal token;
    address internal constant SELLER = address(0x5E11);

    function setUp() public {
        enforcer = new ERC20PerTransferCapEnforcer();
        token = new SymbolicDomainToken();
        address[] memory sellers = new address[](1);
        sellers[0] = SELLER;
        vault = new X402Vault(address(0x0A11CE), address(0xA6E), address(token), 1_000_000, sellers);
    }

    /// For ANY terms, ANY mode and ANY execution (target, value, calldata of the lengths Halmos is told to try):
    /// if the hook does not revert, then the mode's call type is single and its exec type default (the only bytes
    /// of the mode the DeleGator acts on), and the execution is exactly
    /// `token.transfer(to, amount)` with value 0 and amount <= maxAmount.
    function check_perTransferCap_onlyCappedTransferPasses(
        address termToken,
        uint256 maxAmount,
        bytes32 mode,
        address target,
        uint256 value,
        bytes calldata callData
    )
        public
        view
    {
        bytes memory terms = abi.encodePacked(termToken, maxAmount);
        bytes memory execution = abi.encodePacked(target, value, callData);
        try enforcer.beforeHook(terms, hex"", ModeCode.wrap(mode), execution, bytes32(0), address(0), address(0)) {
            assert(bytes1(mode) == bytes1(ModeCode.unwrap(ModeLib.encodeSimpleSingle()))); // CALLTYPE_SINGLE
            assert(bytes1(mode << 8) == 0x00); // EXECTYPE_DEFAULT
            assert(target == termToken);
            assert(value == 0);
            assert(callData.length == 68);
            assert(bytes4(callData[0:4]) == IERC20.transfer.selector);
            assert(uint256(bytes32(callData[36:68])) <= maxAmount);
        } catch { }
    }

    /// The hook never accepts terms of the wrong length (no "missing cap means no cap").
    function check_perTransferCap_rejectsMalformedTerms(bytes calldata terms) public view {
        vm.assume(terms.length != 52);
        try enforcer.getTermsInfo(terms) {
            assert(false);
        } catch { }
    }

    /// For ANY hash and ANY payment fields + agent signature (ABI-encoded the way the vault expects; Halmos can't
    /// follow a symbolic ABI offset, random raw bytes are covered by the fuzz test): if the vault answers "valid",
    /// the recipient is a listed seller, the value is in (0, maxPerPayment], and the hash is exactly the
    /// TransferWithAuthorization digest FROM the vault for those fields. So nothing but a capped payment to a
    /// listed seller can ever be approved by the vault.
    function check_vault_onlyApprovesCappedPaymentToListedSeller(
        bytes32 hash,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata agentSig
    )
        public
        view
    {
        bytes memory signature = abi.encode(to, value, validAfter, validBefore, nonce, agentSig);
        if (vault.isValidSignature(hash, signature) != bytes4(0x1626ba7e)) return;
        assert(vault.isSeller(to));
        assert(to == SELLER);
        assert(value > 0 && value <= vault.maxPerPayment());
        bytes32 structHash = keccak256(
            abi.encode(
                vault.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(vault), to, value, validAfter, validBefore, nonce
            )
        );
        assert(hash == keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    /// Once disabled, the vault approves nothing: for ANY hash and ANY payment fields + signature.
    function check_vault_disabledApprovesNothing(
        bytes32 hash,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata agentSig
    )
        public
    {
        vm.prank(vault.owner());
        vault.disable();
        bytes memory signature = abi.encode(to, value, validAfter, validBefore, nonce, agentSig);
        assert(vault.isValidSignature(hash, signature) != bytes4(0x1626ba7e));
    }

    /// Only the owner can change the seller list, withdraw or disable.
    function check_vault_onlyOwnerManages(address caller, address seller, address to, uint256 amount) public {
        vm.assume(caller != vault.owner());
        vm.prank(caller);
        try vault.setSeller(seller, true) {
            assert(false);
        } catch { }
        vm.prank(caller);
        try vault.withdraw(address(token), to, amount) {
            assert(false);
        } catch { }
        vm.prank(caller);
        try vault.disable() {
            assert(false);
        } catch { }
    }
}
