// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {X402Vault} from "../src/X402Vault.sol";

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
        assertEq(
            vault.isValidSignature(_digest(seller, CAP, nonce), _sig(agentKey, seller, CAP, nonce)), bytes4(0x1626ba7e)
        );
    }

    function test_rejectsSellerNotOnList() public {
        bytes32 nonce = keccak256("n2");
        assertEq(
            vault.isValidSignature(_digest(stranger, 1, nonce), _sig(agentKey, stranger, 1, nonce)), bytes4(0xffffffff)
        );
    }

    function test_rejectsAboveCapAndZero() public {
        bytes32 nonce = keccak256("n3");
        assertEq(
            vault.isValidSignature(_digest(seller, CAP + 1, nonce), _sig(agentKey, seller, CAP + 1, nonce)),
            bytes4(0xffffffff)
        );
        assertEq(
            vault.isValidSignature(_digest(seller, 0, nonce), _sig(agentKey, seller, 0, nonce)), bytes4(0xffffffff)
        );
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
        assertEq(
            vault.isValidSignature(_digest(seller, 1, nonce), _sig(agentKey, seller, 1, nonce)), bytes4(0xffffffff)
        );
        vm.prank(owner);
        vault.withdraw(address(token), owner, 1);
    }

    // ---------------- security review (2026-11-21): adversarial cases ----------------

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _domainHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    /// USDC also verifies the vault's ERC-1271 signature for receiveWithAuthorization, cancelAuthorization and
    /// permit (EIP-2612, bytes signature in FiatToken v2.2). Signed by the agent with valid-looking fields, each
    /// must be refused: only TransferWithAuthorization to a listed seller is ever approved.
    function test_rejectsOtherUsdcSignatureTypes() public {
        bytes32 nonce = keccak256("r1");
        bytes memory transferSig = _sig(agentKey, seller, 1, nonce);
        bytes32 receiveHash = _domainHash(
            keccak256(
                abi.encode(RECEIVE_TYPEHASH, address(vault), seller, uint256(1), uint256(0), uint256(1e10), nonce)
            )
        );
        bytes32 cancelHash = _domainHash(keccak256(abi.encode(CANCEL_TYPEHASH, address(vault), nonce)));
        bytes32 permitHash = _domainHash(
            keccak256(
                abi.encode(PERMIT_TYPEHASH, address(vault), stranger, type(uint256).max, uint256(0), uint256(1e10))
            )
        );
        for (uint256 i = 0; i < 3; i++) {
            bytes32 h = i == 0 ? receiveHash : i == 1 ? cancelHash : permitHash;
            // Both the transfer-shaped signature and the agent's direct signature over that hash are refused.
            assertEq(vault.isValidSignature(h, transferSig), bytes4(0xffffffff));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, h);
            assertEq(vault.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        }
    }

    /// OZ ECDSA rejects malleable (high-s) and non-65-byte signatures inside the vault's format.
    function test_rejectsMalleableAndCompactAgentSignatures() public {
        bytes32 nonce = keccak256("m1");
        bytes32 digest = _digest(seller, 1, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // secp256k1 curve order (public constant) allow-secret
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable =
            abi.encode(seller, uint256(1), uint256(0), uint256(1e10), nonce, abi.encodePacked(r, highS, flippedV));
        assertEq(vault.isValidSignature(digest, malleable), bytes4(0xffffffff));
        bytes memory compact = abi.encode(seller, uint256(1), uint256(0), uint256(1e10), nonce, abi.encodePacked(r, s));
        assertEq(vault.isValidSignature(digest, compact), bytes4(0xffffffff));
    }

    /// Fuzz: for random payment fields, the vault approves iff the recipient is listed, 0 < value <= cap, the
    /// hash is exactly the TransferWithAuthorization digest, and the agent signed it.
    function testFuzz_onlyListedSellerWithinCap(address to, uint256 value, bytes32 nonce, bytes32 otherHash) public {
        vm.assume(to != address(0));
        bytes memory sig = _sig(agentKey, to, value, nonce);
        bytes32 digest = _digest(to, value, nonce);
        bool shouldPass = to == seller && value > 0 && value <= CAP;
        assertEq(vault.isValidSignature(digest, sig) == bytes4(0x1626ba7e), shouldPass);
        if (otherHash != digest) assertEq(vault.isValidSignature(otherHash, sig), bytes4(0xffffffff));
    }

    /// Plain ETH can't be sent to the vault by mistake (no receive/fallback), so nothing gets stuck that way.
    function test_rejectsPlainEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }
}

