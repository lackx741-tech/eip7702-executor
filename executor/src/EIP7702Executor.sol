// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EIP7702Executor
 * @notice Smart contract executor for EIP-7702 delegation.
 *
 * When a user delegates their EOA to this contract via EIP-7702 Type-4 tx:
 *   - address(this) == user's EOA
 *   - All calls happen AS the user's wallet
 *   - farm.harvest(address(this)) => rewards land in user's wallet
 *   - IERC20.balanceOf(address(this)) => user's real balance
 *   - No approvals needed — the EOA IS the executor for this tx
 *
 * Supports:
 *   1. Arbitrary batch calls (harvest, claim, collect fees, etc.)
 *   2. ERC-20 token sweeping after calls complete
 *   3. Native token sweeping minus relayer fee
 */
contract EIP7702Executor is ReentrancyGuard {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    error Unauthorized();
    error CallFailed(uint256 index, bytes reason);
    error InvalidSignature();
    error DeadlineExpired();
    error NonceAlreadyUsed();
    error ZeroAddress();

    struct Call {
        address target;
        uint256 value;
        bytes   data;
    }

    struct BatchIntent {
        address   user;
        Call[]    calls;
        address[] sweepTokens;
        bool      sweepNative;
        address   destination;
        uint256   maxFeeWei;
        uint256   deadline;
        uint256   nonce;
    }

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant BATCH_INTENT_TYPEHASH = keccak256(
        "BatchIntent(address user,address destination,bytes32 callsHash,bytes32 tokensHash,bool sweepNative,uint256 maxFeeWei,uint256 deadline,uint256 nonce)"
    );

    address public immutable relayer;
    string  public constant  NAME    = "EIP7702Executor";
    string  public constant  VERSION = "1";

    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event BatchExecuted(
        address indexed user,
        address indexed destination,
        uint256 callCount,
        uint256 tokenCount,
        uint256 nativeSwept,
        uint256 fee,
        uint256 nonce
    );
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event CallExecuted(uint256 indexed index, address indexed target, bool success);

    constructor(address _relayer) {
        if (_relayer == address(0)) revert ZeroAddress();
        relayer = _relayer;
    }

    /**
     * @notice Execute batch calls then sweep all assets to destination.
     *
     * IMPORTANT: Called by relayer on the USER's EOA address (not this contract's address).
     * Via EIP-7702, the user's EOA code is set to delegate here, so address(this) == user's EOA.
     *
     * @param intent  Signed BatchIntent from the user
     * @param sig     EIP-712 signature (signed by user's EOA private key)
     */
    function executeBatch(
        BatchIntent calldata intent,
        bytes calldata sig
    ) external payable nonReentrant {
        if (msg.sender != relayer) revert Unauthorized();
        if (block.timestamp > intent.deadline) revert DeadlineExpired();
        if (usedNonces[intent.user][intent.nonce]) revert NonceAlreadyUsed();
        usedNonces[intent.user][intent.nonce] = true;

        _verifySignature(intent, sig);

        // STEP 1: Execute all calls as the user's EOA
        // address(this) == user's EOA, so protocols receive/send from user's wallet
        for (uint256 i = 0; i < intent.calls.length; i++) {
            (bool ok, bytes memory reason) = intent.calls[i].target.call{
                value: intent.calls[i].value
            }(intent.calls[i].data);
            emit CallExecuted(i, intent.calls[i].target, ok);
            if (!ok) revert CallFailed(i, reason);
        }

        // STEP 2: Sweep ERC-20 tokens
        for (uint256 i = 0; i < intent.sweepTokens.length; i++) {
            address token = intent.sweepTokens[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) {
                IERC20(token).safeTransfer(intent.destination, bal);
                emit TokenSwept(token, intent.destination, bal);
            }
        }

        // STEP 3: Sweep native balance minus fee
        uint256 fee = 0;
        uint256 nativeSwept = 0;

        if (intent.sweepNative) {
            uint256 nativeBal = address(this).balance;
            if (nativeBal > intent.maxFeeWei) {
                fee = intent.maxFeeWei;
                nativeSwept = nativeBal - fee;
                (bool feeOk,) = relayer.call{value: fee}("");
                require(feeOk, "Fee transfer failed");
                if (nativeSwept > 0) {
                    (bool ok,) = intent.destination.call{value: nativeSwept}("");
                    require(ok, "Native sweep failed");
                }
            } else if (nativeBal > 0) {
                fee = nativeBal;
                (bool feeOk,) = relayer.call{value: fee}("");
                require(feeOk, "Fee transfer failed");
            }
        }

        emit BatchExecuted(
            intent.user,
            intent.destination,
            intent.calls.length,
            intent.sweepTokens.length,
            nativeSwept,
            fee,
            intent.nonce
        );
    }

    function domainSeparator(address verifyingContract) public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            verifyingContract
        ));
    }

    function _verifySignature(BatchIntent calldata intent, bytes calldata sig) internal view {
        bytes32 callsHash  = _hashCalls(intent.calls);
        bytes32 tokensHash = keccak256(abi.encodePacked(intent.sweepTokens));

        bytes32 structHash = keccak256(abi.encode(
            BATCH_INTENT_TYPEHASH,
            intent.user,
            intent.destination,
            callsHash,
            tokensHash,
            intent.sweepNative,
            intent.maxFeeWei,
            intent.deadline,
            intent.nonce
        ));

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(intent.user), structHash)
        );

        address signer = digest.recover(sig);
        if (signer != intent.user) revert InvalidSignature();
    }

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            hashes[i] = keccak256(abi.encode(
                calls[i].target,
                calls[i].value,
                keccak256(calls[i].data)
            ));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    receive() external payable {}
    fallback() external payable {}
}
