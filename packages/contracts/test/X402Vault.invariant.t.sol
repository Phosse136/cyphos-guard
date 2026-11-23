// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { X402Vault } from "../src/X402Vault.sol";

/// @dev An EIP-3009 token that, like USDC FiatToken v2.2, asks a contract payer via ERC-1271 and burns nonces.
///      Every transfer out of the vault is recorded with the facts the invariants need.
contract Eip3009Token {
    bytes32 public constant DOMAIN_SEPARATOR = keccak256("eip3009-mock-domain");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    struct Outflow {
        address to;
        uint256 value;
        bool toWasSeller;
        bool byOwner;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    Outflow[] public outflows;
    X402Vault public vault;

    function setVault(X402Vault v) external {
        vault = v;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function outflowCount() external view returns (uint256) {
        return outflows.length;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        // The vault only calls transfer() from withdraw(), which is onlyOwner (strangers trying it are counted
        // by the handler); payments go through transferWithAuthorization.
        _move(msg.sender, to, value, msg.sender == address(vault));
        return true;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    )
        external
    {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "auth: time");
        require(!authorizationState[from][nonce], "auth: used");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
            )
        );
        require(IERC1271(from).isValidSignature(digest, signature) == 0x1626ba7e, "auth: signature");
        authorizationState[from][nonce] = true;
        _move(from, to, value, false);
    }

    function _move(address from, address to, uint256 value, bool byOwner) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        if (from == address(vault)) outflows.push(Outflow(to, value, vault.isSeller(to), byOwner));
    }
}

/// @dev Everything an attacker (holding the AGENT key, or not) and the owner can do to the vault, in random order.
contract VaultHandler is Test {
    X402Vault internal vault;
    Eip3009Token internal token;
    uint256 internal agentKey;
    address internal owner;
    address[] internal sellers;
    bytes[] internal usedAuthorizations; // calldata of payments that went through, for replay attempts
    uint256 public successfulPayments;
    uint256 public strayAuthorizations; // payments that went through although the handler expected a revert

    constructor(X402Vault v, Eip3009Token t, uint256 agentKey_, address owner_, address[] memory sellers_) {
        vault = v;
        token = t;
        agentKey = agentKey_;
        owner = owner_;
        sellers = sellers_;
    }

    function _auth(uint256 key, address to, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        uint256 validBefore = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(vault), to, value, 0, validBefore, nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        bytes memory sig = abi.encode(to, value, uint256(0), validBefore, nonce, abi.encodePacked(r, s, v));
        return abi.encodeCall(
            Eip3009Token.transferWithAuthorization, (address(vault), to, value, 0, validBefore, nonce, sig)
        );
    }

    function _submit(bytes memory call) internal returns (bool ok) {
        (ok,) = address(token).call(call);
        if (ok) usedAuthorizations.push(call);
    }

    /// The agent pays a listed seller within the cap: must work while the vault has funds.
    function payListedSeller(uint256 sellerSeed, uint256 value, bytes32 nonce) external {
        address to = sellers[sellerSeed % sellers.length];
        value = bound(value, 1, vault.maxPerPayment());
        if (token.balanceOf(address(vault)) < value || !vault.isSeller(to)) return;
        if (token.authorizationState(address(vault), nonce)) return;
        require(_submit(_auth(agentKey, to, value, nonce)), "valid payment refused");
        successfulPayments++;
    }

    /// The (compromised) agent signs a payment to anyone, of any size.
    function agentPaysAnyone(address to, uint256 value, bytes32 nonce) external {
        if (vault.isSeller(to) && value > 0 && value <= vault.maxPerPayment()) return; // that's the allowed case
        if (_submit(_auth(agentKey, to, value, nonce))) strayAuthorizations++;
    }

    /// Someone without the agent key forges a payment, even to a listed seller.
    function strangerForges(uint256 key, uint256 sellerSeed, uint256 value, bytes32 nonce) external {
        key = bound(key, 1, 1e30);
        if (key == agentKey) return;
        if (_submit(_auth(key, sellers[sellerSeed % sellers.length], value, nonce))) strayAuthorizations++;
    }

    /// Replays a payment that already went through.
    function replay(uint256 i) external {
        if (usedAuthorizations.length == 0) return;
        (bool ok,) = address(token).call(usedAuthorizations[i % usedAuthorizations.length]);
        if (ok) strayAuthorizations++;
    }

    /// Strangers try the owner's functions.
    function strangerManages(address who, address seller, uint256 amount) external {
        if (who == owner) return;
        vm.startPrank(who);
        try vault.setSeller(seller, true) {
            strayAuthorizations++;
        } catch { }
        try vault.withdraw(address(token), who, amount) {
            strayAuthorizations++;
        } catch { }
        vm.stopPrank();
    }

    /// The owner removes or re-adds a seller, tops up, or withdraws (all legitimate).
    function ownerActs(uint256 action, uint256 sellerSeed, uint256 amount) external {
        address seller = sellers[sellerSeed % sellers.length];
        vm.startPrank(owner);
        if (action % 3 == 0) vault.setSeller(seller, !vault.isSeller(seller));
        else if (action % 3 == 1) token.mint(address(vault), bound(amount, 0, 100e6));
        else vault.withdraw(address(token), owner, bound(amount, 0, token.balanceOf(address(vault))));
        vm.stopPrank();
    }

    function warp(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 0, 1 days));
    }
}

/// Invariants of the vault under random sequences of the actions above.
contract X402VaultInvariantTest is Test {
    X402Vault internal vault;
    Eip3009Token internal token;
    VaultHandler internal handler;
    address internal owner = address(0x0A11CE);
    uint256 internal constant CAP = 1_000_000; // 1 USDC

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new Eip3009Token();
        address[] memory sellers = new address[](2);
        sellers[0] = address(0x5E11);
        sellers[1] = address(0x5E12);
        uint256 agentKey = 0xA6E17;
        vault = new X402Vault(owner, vm.addr(agentKey), address(token), CAP, sellers);
        token.setVault(vault);
        token.mint(address(vault), 50e6);
        handler = new VaultHandler(vault, token, agentKey, owner, sellers);
        targetContract(address(handler));
        bytes4[] memory actions = new bytes4[](7);
        actions[0] = VaultHandler.payListedSeller.selector;
        actions[1] = VaultHandler.agentPaysAnyone.selector;
        actions[2] = VaultHandler.strangerForges.selector;
        actions[3] = VaultHandler.replay.selector;
        actions[4] = VaultHandler.strangerManages.selector;
        actions[5] = VaultHandler.ownerActs.selector;
        actions[6] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: actions }));
    }

    /// Money leaves the vault only to a seller that is listed at that moment, at most CAP per payment, or back
    /// to the owner when the owner withdraws.
    function invariant_outflowsOnlyToListedSellersWithinCapOrOwner() public {
        for (uint256 i = 0; i < token.outflowCount(); i++) {
            (, uint256 value, bool toWasSeller, bool byOwner) = token.outflows(i);
            if (byOwner) continue;
            assertTrue(toWasSeller, "paid someone who was not a listed seller");
            assertGt(value, 0, "zero-value authorization accepted");
            assertLe(value, CAP, "payment above maxPerPayment");
        }
    }

    /// No forged, oversized, replayed or unlisted payment, and no stranger managing the vault, ever succeeded.
    function invariant_noStrayAuthorization() public {
        assertEq(handler.strayAuthorizations(), 0);
    }

    /// The run is meaningful: legitimate payments do go through (the invariants are not vacuously true).
    function afterInvariant() public {
        assertGt(handler.successfulPayments(), 0, "no legitimate payment in this run");
    }
}
