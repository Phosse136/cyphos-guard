// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IEIP3009Token {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title X402Vault (EXPERIMENTAL, testnet only, not audited)
/// @notice The payer for an agent's x402 payments, so that WHO gets paid is enforced on-chain.
///
/// x402's "exact" scheme has the payer sign an EIP-3009 TransferWithAuthorization; the token (e.g. USDC
/// FiatToken v2.2) verifies a contract payer through ERC-1271 isValidSignature. This vault answers "valid"
/// ONLY for a TransferWithAuthorization of `token` FROM this vault TO an allowed seller, no larger than
/// `maxPerPayment`, and signed by `agent`. Every other hash (permit, receiveWithAuthorization, arbitrary
/// messages) is rejected, because the vault recomputes the one digest it is willing to approve.
///
/// A stolen agent key can therefore only pay listed sellers, at most `maxPerPayment` per payment, out of
/// whatever the owner put in the vault. The owner (the user's smart account) manages sellers and can withdraw.
///
/// `disable()` switches the vault off for good: from then on it approves nothing, including authorizations the
/// agent key signed earlier (the vault doesn't bound `validBefore`, so a stolen key could hold long-lived ones).
/// Revoking a grant calls it. It is one-way on purpose: a revoked vault is never reused for a new grant.
///
/// Signature format expected in isValidSignature:
///   abi.encode(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes agentSig)
/// where agentSig is the agent's 65-byte ECDSA signature over the same EIP-712 digest.
contract X402Vault is IERC1271 {
    using SafeERC20 for IERC20;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes4 internal constant MAGIC = IERC1271.isValidSignature.selector; // 0x1626ba7e
    bytes4 internal constant INVALID = 0xffffffff;

    /// @notice The user's smart account: manages sellers, withdraws.
    address public immutable owner;
    /// @notice The agent's EOA whose signature authorizes payments.
    address public immutable agent;
    /// @notice The EIP-3009 token paid out (e.g. USDC).
    address public immutable token;
    /// @notice Largest single payment the vault will approve.
    uint256 public immutable maxPerPayment;

    mapping(address seller => bool allowed) public isSeller;
    /// @notice Set once by `disable()`; the vault then approves no payment ever again.
    bool public disabled;

    event SellerSet(address indexed seller, bool allowed);
    event Withdrawn(address indexed to, uint256 amount);
    event Disabled();

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address agent_, address token_, uint256 maxPerPayment_, address[] memory sellers_) {
        if (owner_ == address(0) || agent_ == address(0) || token_ == address(0)) revert ZeroAddress();
        owner = owner_;
        agent = agent_;
        token = token_;
        maxPerPayment = maxPerPayment_;
        for (uint256 i = 0; i < sellers_.length; i++) {
            _setSeller(sellers_[i], true);
        }
    }

    /// @inheritdoc IERC1271
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        // 6 head words (the last is agentSig's offset) + its length word + 65 bytes padded to 96 = 320 bytes.
        if (disabled || signature.length < 32 * 7 + 96) return INVALID;
        (address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory agentSig) =
            abi.decode(signature, (address, uint256, uint256, uint256, bytes32, bytes));
        if (!isSeller[to] || value == 0 || value > maxPerPayment) return INVALID;

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IEIP3009Token(token).DOMAIN_SEPARATOR(), structHash));
        if (digest != hash) return INVALID;

        // slither-disable-next-line unused-return (the third value is only a detail of err, which is checked)
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, agentSig);
        if (err != ECDSA.RecoverError.NoError || signer != agent) return INVALID;
        return MAGIC;
    }

    /// @notice Owner switches the vault off for good (called on revoke). Withdraw still works afterwards.
    function disable() external onlyOwner {
        disabled = true;
        emit Disabled();
    }

    function setSeller(address seller, bool allowed) external onlyOwner {
        _setSeller(seller, allowed);
    }

    /// @notice Owner pulls funds back (e.g. to the smart account). Any token, in case something else lands here.
    ///         `amount == type(uint256).max` withdraws the whole balance at execution time, so a payment that lands
    ///         between reading the balance and the withdraw can't make the owner's transaction revert.
    function withdraw(address token_, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == type(uint256).max) amount = IERC20(token_).balanceOf(address(this));
        // slither-disable-next-line reentrancy-events (onlyOwner, no state after the call; event order is cosmetic)
        IERC20(token_).safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function _setSeller(address seller, bool allowed) internal {
        if (seller == address(0)) revert ZeroAddress();
        isSeller[seller] = allowed;
        emit SellerSet(seller, allowed);
    }
}
