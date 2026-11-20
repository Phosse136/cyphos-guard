// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.23;

import { CaveatEnforcer } from "@delegator/src/enforcers/CaveatEnforcer.sol";
import { ModeCode } from "@delegator/src/utils/Types.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title CosignerEnforcer
 * @notice Requires a fresh signature from a designated co-signer for every redemption of a delegation.
 *
 * The delegator (owner) fixes the co-signer address in `terms`, which is covered by the delegation signature.
 * The redeemer (agent) supplies the cosignature in `args` at redemption time; `args` are not part of the
 * delegation hash, so a cosignature can be attached without the owner signing again.
 *
 * The cosignature is an EIP-712 signature over: the DelegationManager calling this enforcer, the delegation
 * hash, the redeemer, the keccak256 of the exact execution calldata, a salt and a deadline. Each cosignature
 * is accepted at most once per DelegationManager.
 *
 * Security properties:
 * - The co-signer can only BLOCK: a cosignature adds a requirement, it grants nothing. Without the agent and
 *   the owner-signed delegation (with all its other caveats) a cosignature moves no funds.
 * - A cosignature is bound to one delegation, one redeemer, one exact execution, one DelegationManager and this
 *   chain/enforcer (EIP-712 domain); it expires at `deadline` and cannot be replayed.
 * - If the co-signer key leaks, the remaining protection is the delegation's other (on-chain) caveats.
 *
 * Only single-call, default-execution mode is supported, so the signed calldata is exactly what executes.
 *
 * terms: abi.encodePacked(address cosigner)                      (20 bytes)
 * args:  abi.encode(bytes32 salt, uint256 deadline, bytes signature)
 */
contract CosignerEnforcer is CaveatEnforcer, EIP712 {
    bytes32 public constant COSIGN_TYPEHASH = keccak256(
        "Cosign(address delegationManager,bytes32 delegationHash,address redeemer,bytes32 executionHash,bytes32 salt,uint256 deadline)"
    );

    /// @dev Keyed by msg.sender (the DelegationManager), like the framework's own stateful enforcers: anyone can
    ///      call the hook directly, but can only consume entries in their own namespace.
    mapping(address delegationManager => mapping(bytes32 digest => bool used)) public usedCosignatures;

    event Cosigned(
        address indexed delegationManager, bytes32 indexed delegationHash, address indexed cosigner, bytes32 digest
    );

    constructor() EIP712("cyphos-guard CosignerEnforcer", "1") { }

    function beforeHook(
        bytes calldata _terms,
        bytes calldata _args,
        ModeCode _mode,
        bytes calldata _executionCallData,
        bytes32 _delegationHash,
        address,
        address _redeemer
    )
        public
        override
        onlySingleCallTypeMode(_mode)
        onlyDefaultExecutionMode(_mode)
    {
        address cosigner_ = getTermsInfo(_terms);
        require(_args.length != 0, "CosignerEnforcer:missing-cosignature");
        (bytes32 salt_, uint256 deadline_, bytes memory signature_) = abi.decode(_args, (bytes32, uint256, bytes));
        require(block.timestamp <= deadline_, "CosignerEnforcer:expired");

        bytes32 digest_ =
            getCosignDigest(msg.sender, _delegationHash, _redeemer, keccak256(_executionCallData), salt_, deadline_);
        require(!usedCosignatures[msg.sender][digest_], "CosignerEnforcer:already-used");

        (address recovered_, ECDSA.RecoverError error_,) = ECDSA.tryRecover(digest_, signature_);
        require(error_ == ECDSA.RecoverError.NoError && recovered_ == cosigner_, "CosignerEnforcer:invalid-cosignature");

        usedCosignatures[msg.sender][digest_] = true;
        emit Cosigned(msg.sender, _delegationHash, cosigner_, digest_);
    }

    /// @notice Decodes the co-signer address from the terms.
    function getTermsInfo(bytes calldata _terms) public pure returns (address cosigner_) {
        require(_terms.length == 20, "CosignerEnforcer:invalid-terms-length");
        cosigner_ = address(bytes20(_terms));
        require(cosigner_ != address(0), "CosignerEnforcer:zero-cosigner");
    }

    /// @notice The EIP-712 digest the co-signer signs.
    function getCosignDigest(
        address _delegationManager,
        bytes32 _delegationHash,
        address _redeemer,
        bytes32 _executionHash,
        bytes32 _salt,
        uint256 _deadline
    )
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    COSIGN_TYPEHASH, _delegationManager, _delegationHash, _redeemer, _executionHash, _salt, _deadline
                )
            )
        );
    }
}
