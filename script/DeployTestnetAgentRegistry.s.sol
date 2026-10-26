// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Testnet stand-in for the Binance Agent ID registry, with the same
///         two read functions. Owner-assigned handles; one handle per address.
contract TestnetAgentRegistry {
    address public immutable owner;
    mapping(address => string) internal _handles;
    mapping(bytes32 => address) internal _owners;

    event HandleSet(address indexed account, string handle);

    constructor(address owner_) {
        owner = owner_;
    }

    function setHandle(address account, string calldata handle) external {
        require(msg.sender == owner, "owner");
        string memory old = _handles[account];
        if (bytes(old).length != 0) delete _owners[keccak256(bytes(old))];
        _handles[account] = handle;
        if (bytes(handle).length != 0) _owners[keccak256(bytes(handle))] = account;
        emit HandleSet(account, handle);
    }

    function handleOf(address account) external view returns (string memory) {
        return _handles[account];
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return _owners[keccak256(bytes(handle))];
    }
}

/// @notice BSC testnet only. `REGISTRY_OWNER` assigns handles to testers.
contract DeployTestnetAgentRegistry is Script {
    function run() external returns (TestnetAgentRegistry registry) {
        require(block.chainid != 56, "never on mainnet");
        address owner = vm.envAddress("REGISTRY_OWNER");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        registry = new TestnetAgentRegistry(owner);
        vm.stopBroadcast();
        console2.log("TestnetAgentRegistry:", address(registry));
    }
}
