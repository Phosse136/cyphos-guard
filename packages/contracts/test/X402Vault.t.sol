// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { X402Vault } from "../src/X402Vault.sol";

/// @dev Minimal EIP-3009-style token domain for unit tests (the real FiatToken path is covered by the fork test).
contract MockToken {
    bytes32 public constant DOMAIN_SEPARATOR = keccak256("mock-usdc-domain");

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract X402VaultTest is Test {
    X402Vault internal vault;
    MockToken internal token;
    uint256 internal agentKey = 0xA6E;
    address internal agent;
    address internal owner = address(0x0A);
    address internal seller = address(0x5E11);
    address internal stranger = address(0xBAD);
    uint256 internal constant CAP = 1_000_000;

    function setUp() public {
        agent = vm.addr(agentKey);
        token = new MockToken();
        address[] memory sellers = new address[](1);
        sellers[0] = seller;
        vault = new X402Vault(owner, agent, address(token), CAP, sellers);
    }

    function _digest(address to, uint256 value, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(vault.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(vault), to, value, 0, 1e10, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _sig(uint256 key, address to, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(to, value, nonce));
        return abi.encode(to, value, uint256(0), uint256(1e10), nonce, abi.encodePacked(r, s, v));
    }

    function test_validForAllowedSellerWithinCap() public {
        bytes32 nonce = keccak256("n1");
        assertEq(vault.isValidSignature(_digest(seller, CAP, nonce), _sig(agentKey, seller, CAP, nonce)), bytes4(0x1626ba7e));
    }

    function test_rejectsSellerNotOnList() public {
        bytes32 nonce = keccak256("n2");
        assertEq(vault.isValidSignature(_digest(stranger, 1, nonce), _sig(agentKey, stranger, 1, nonce)), bytes4(0xffffffff));
    }

    function test_rejectsAboveCapAndZero() public {
        bytes32 nonce = keccak256("n3");
        assertEq(
            vault.isValidSignature(_digest(seller, CAP + 1, nonce), _sig(agentKey, seller, CAP + 1, nonce)),
            bytes4(0xffffffff)
        );
        assertEq(vault.isValidSignature(_digest(seller, 0, nonce), _sig(agentKey, seller, 0, nonce)), bytes4(0xffffffff));
    }

    function test_rejectsWrongSigner() public {
        bytes32 nonce = keccak256("n4");
        assertEq(vault.isValidSignature(_digest(seller, 1, nonce), _sig(0xBEEF, seller, 1, nonce)), bytes4(0xffffffff));
    }

    /// The claimed fields must produce exactly the hash being checked: a valid-looking payment to a seller
    /// can't be used to approve some OTHER hash (e.g. a permit or a transfer to someone else).
    function test_rejectsHashMismatch() public {
        bytes32 nonce = keccak256("n5");
        bytes memory sig = _sig(agentKey, seller, 1, nonce);
        assertEq(vault.isValidSignature(_digest(stranger, 1, nonce), sig), bytes4(0xffffffff));
        assertEq(vault.isValidSignature(keccak256("permit(...)"), sig), bytes4(0xffffffff));
    }

    function test_rejectsMalformedSignatures() public {
        bytes32 h = _digest(seller, 1, keccak256("n6"));
        assertEq(vault.isValidSignature(h, ""), bytes4(0xffffffff));
        assertEq(vault.isValidSignature(h, new bytes(65)), bytes4(0xffffffff));
    }

    function test_onlyOwnerManagesSellersAndWithdraws() public {
        vm.prank(stranger);
        vm.expectRevert(X402Vault.NotOwner.selector);
        vault.setSeller(stranger, true);
        vm.prank(stranger);
        vm.expectRevert(X402Vault.NotOwner.selector);
        vault.withdraw(address(token), stranger, 1);

        vm.prank(owner);
        vault.setSeller(seller, false);
        bytes32 nonce = keccak256("n7");
        assertEq(vault.isValidSignature(_digest(seller, 1, nonce), _sig(agentKey, seller, 1, nonce)), bytes4(0xffffffff));
        vm.prank(owner);
        vault.withdraw(address(token), owner, 1);
    }
}
