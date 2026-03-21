// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/EIP7702Executor.sol";

contract Deploy is Script {
    bytes32 constant SALT = keccak256("EIP7702Executor_v1");

    function run() external {
        address relayerAddr = vm.envAddress("RELAYER_ADDRESS");
        vm.startBroadcast();
        EIP7702Executor executor = new EIP7702Executor{salt: SALT}(relayerAddr);
        vm.stopBroadcast();

        console.log("EIP7702Executor deployed at:", address(executor));
        console.log("Relayer:", relayerAddr);
        console.log("Chain ID:", block.chainid);
    }
}
