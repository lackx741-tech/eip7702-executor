// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/EIP7702Executor.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock contracts
// ─────────────────────────────────────────────────────────────────────────────

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockFarm {
    MockERC20 public rewardToken;

    constructor(MockERC20 _rewardToken) {
        rewardToken = _rewardToken;
    }

    function harvest(address to) external {
        rewardToken.mint(to, 100e18);
    }
}

contract MockStaking {
    MockERC20 public rewardToken;

    constructor(MockERC20 _rewardToken) {
        rewardToken = _rewardToken;
    }

    function getReward() external {
        rewardToken.mint(msg.sender, 50e18);
    }
}

contract MockUniV3PositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    MockERC20 public usdc;

    constructor(MockERC20 _usdc) {
        usdc = _usdc;
    }

    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1) {
        usdc.mint(params.recipient, 200e6);
        return (200e6, 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────────────────────────────────────

contract EIP7702ExecutorTest is Test {
    EIP7702Executor public executor;
    MockERC20       public rewardToken;
    MockERC20       public usdc;
    MockFarm        public farm;
    MockStaking     public staking;
    MockUniV3PositionManager public uniV3;

    address public relayer;
    address public userEOA;
    address public destination;
    uint256 public userPrivKey;

    function setUp() public {
        relayer     = makeAddr("relayer");
        destination = makeAddr("destination");

        userPrivKey = 0xA11CE;
        userEOA     = vm.addr(userPrivKey);

        executor    = new EIP7702Executor(relayer);
        rewardToken = new MockERC20("Reward", "RWD");
        usdc        = new MockERC20("USD Coin", "USDC");
        farm        = new MockFarm(rewardToken);
        staking     = new MockStaking(rewardToken);
        uniV3       = new MockUniV3PositionManager(usdc);

        // Simulate EIP-7702: etch executor bytecode onto userEOA
        vm.etch(userEOA, address(executor).code);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: sign a BatchIntent with the given private key
    // ─────────────────────────────────────────────────────────────────────────

    function _signIntent(
        EIP7702Executor.BatchIntent memory intent,
        uint256 privKey
    ) internal view returns (bytes memory) {
        // Compute callsHash — must match _hashCalls() in the contract
        bytes32[] memory callHashes = new bytes32[](intent.calls.length);
        for (uint256 i = 0; i < intent.calls.length; i++) {
            callHashes[i] = keccak256(abi.encode(
                intent.calls[i].target,
                intent.calls[i].value,
                keccak256(intent.calls[i].data)
            ));
        }
        bytes32 callsHash = keccak256(abi.encodePacked(callHashes));

        // Compute tokensHash — must match keccak256(abi.encodePacked(sweepTokens)) in contract
        bytes32 tokensHash = keccak256(abi.encodePacked(intent.sweepTokens));

        bytes32 structHash = keccak256(abi.encode(
            executor.BATCH_INTENT_TYPEHASH(),
            intent.user,
            intent.destination,
            callsHash,
            tokensHash,
            intent.sweepNative,
            intent.maxFeeWei,
            intent.deadline,
            intent.nonce
        ));

        // EIP-712 digest — verifyingContract is the user's EOA (EIP-7702 semantics)
        bytes32 domSep = keccak256(abi.encode(
            executor.DOMAIN_TYPEHASH(),
            keccak256(bytes(executor.NAME())),
            keccak256(bytes(executor.VERSION())),
            block.chainid,
            intent.user          // verifyingContract == user's EOA
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: native sweep
    // ─────────────────────────────────────────────────────────────────────────

    function test_nativeSweep() public {
        vm.deal(userEOA, 1 ether);

        uint256 maxFee = 0.01 ether;

        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: true,
            destination: destination,
            maxFeeWei:   maxFee,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        uint256 relayerBefore = relayer.balance;
        uint256 destBefore    = destination.balance;

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        assertEq(relayer.balance - relayerBefore, maxFee, "relayer fee");
        assertEq(destination.balance - destBefore, 1 ether - maxFee, "destination received");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: ERC-20 sweep
    // ─────────────────────────────────────────────────────────────────────────

    function test_erc20Sweep() public {
        rewardToken.mint(userEOA, 1000e18);

        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](1);
        tokens[0] = address(rewardToken);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        assertEq(rewardToken.balanceOf(destination), 1000e18, "destination received tokens");
        assertEq(rewardToken.balanceOf(userEOA), 0, "userEOA drained");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: harvest and sweep
    // ─────────────────────────────────────────────────────────────────────────

    function test_harvestAndSweep() public {
        // Build harvest call: farm.harvest(address(this)) where address(this) == userEOA
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](1);
        calls[0] = EIP7702Executor.Call({
            target: address(farm),
            value:  0,
            data:   abi.encodeWithSignature("harvest(address)", userEOA)
        });

        address[] memory tokens = new address[](1);
        tokens[0] = address(rewardToken);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        assertEq(rewardToken.balanceOf(destination), 100e18, "destination got harvest rewards");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: getReward and sweep
    // ─────────────────────────────────────────────────────────────────────────

    function test_getRewardAndSweep() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](1);
        calls[0] = EIP7702Executor.Call({
            target: address(staking),
            value:  0,
            data:   abi.encodeWithSignature("getReward()")
        });

        address[] memory tokens = new address[](1);
        tokens[0] = address(rewardToken);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        // staking mints to msg.sender which is the userEOA (address(this) in executeBatch)
        assertEq(rewardToken.balanceOf(destination), 50e18, "destination got staking rewards");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: batch multiple calls (harvest + getReward + uniV3 collect)
    // ─────────────────────────────────────────────────────────────────────────

    function test_batchMultipleCalls() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](3);

        // 1) farm.harvest(userEOA)
        calls[0] = EIP7702Executor.Call({
            target: address(farm),
            value:  0,
            data:   abi.encodeWithSignature("harvest(address)", userEOA)
        });

        // 2) staking.getReward()
        calls[1] = EIP7702Executor.Call({
            target: address(staking),
            value:  0,
            data:   abi.encodeWithSignature("getReward()")
        });

        // 3) uniV3.collect(params)
        MockUniV3PositionManager.CollectParams memory params = MockUniV3PositionManager.CollectParams({
            tokenId:    1,
            recipient:  userEOA,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        calls[2] = EIP7702Executor.Call({
            target: address(uniV3),
            value:  0,
            data:   abi.encodeWithSelector(MockUniV3PositionManager.collect.selector, params)
        });

        address[] memory tokens = new address[](2);
        tokens[0] = address(rewardToken);
        tokens[1] = address(usdc);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        // farm minted 100e18, staking minted 50e18
        assertEq(rewardToken.balanceOf(destination), 150e18, "all reward tokens swept");
        // uniV3 minted 200e6 USDC
        assertEq(usdc.balanceOf(destination), 200e6, "USDC swept");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: replay prevention
    // ─────────────────────────────────────────────────────────────────────────

    function test_replayPrevented() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);

        vm.prank(relayer);
        vm.expectRevert(EIP7702Executor.NonceAlreadyUsed.selector);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: deadline expired
    // ─────────────────────────────────────────────────────────────────────────

    function test_deadlineExpired() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        uint256 pastDeadline = block.timestamp - 1;

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    pastDeadline,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        vm.prank(relayer);
        vm.expectRevert(EIP7702Executor.DeadlineExpired.selector);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: unauthorized caller
    // ─────────────────────────────────────────────────────────────────────────

    function test_unauthorizedCaller() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(EIP7702Executor.Unauthorized.selector);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: invalid signature
    // ─────────────────────────────────────────────────────────────────────────

    function test_invalidSignature() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        // Sign with a DIFFERENT private key
        uint256 wrongPrivKey = 0xB4D;
        bytes memory sig = _signIntent(intent, wrongPrivKey);

        vm.prank(relayer);
        vm.expectRevert(EIP7702Executor.InvalidSignature.selector);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test: address(this) == userEOA (the core EIP-7702 property)
    // ─────────────────────────────────────────────────────────────────────────

    function test_addressThisEqualsUserEOA() public {
        EIP7702Executor.Call[] memory calls = new EIP7702Executor.Call[](0);
        address[] memory tokens = new address[](0);

        EIP7702Executor.BatchIntent memory intent = EIP7702Executor.BatchIntent({
            user:        userEOA,
            calls:       calls,
            sweepTokens: tokens,
            sweepNative: false,
            destination: destination,
            maxFeeWei:   0,
            deadline:    block.timestamp + 1 hours,
            nonce:       0
        });

        bytes memory sig = _signIntent(intent, userPrivKey);

        // executeBatch is called ON userEOA (which has executor's bytecode etched),
        // so address(this) inside executeBatch == userEOA.
        // The BatchExecuted event records intent.user == userEOA, confirming address(this) == userEOA.
        vm.expectEmit(true, true, false, true, userEOA);
        emit EIP7702Executor.BatchExecuted(userEOA, destination, 0, 0, 0, 0, 0);

        vm.prank(relayer);
        EIP7702Executor(payable(userEOA)).executeBatch(intent, sig);
    }
}
