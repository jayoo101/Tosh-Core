// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stand-in for the Binance Agent ID registry, with switches for every
///         way a real one could misbehave.
contract MockAgentRegistry {
    enum Mode {
        Normal,
        Revert,
        BurnGas,
        BadOffset,
        LengthPastEnd,
        Oversized,
        DirtyAddress
    }

    Mode public mode;
    mapping(address => string) internal _handles;
    mapping(bytes32 => address) internal _owners;

    function setMode(Mode m) external {
        mode = m;
    }

    function setHandle(address account, string calldata handle) external {
        _handles[account] = handle;
        _owners[keccak256(bytes(handle))] = account;
    }

    /// @dev Points a name at an address without updating the reverse entry,
    ///      the shape an admin reassignment would leave behind.
    function setOwnerOnly(string calldata handle, address owner) external {
        _owners[keccak256(bytes(handle))] = owner;
    }

    function handleOf(address account) external view returns (string memory) {
        _misbehave();
        Mode m = mode;
        if (m == Mode.BadOffset) {
            assembly {
                mstore(0x00, 0x40)
                mstore(0x20, 0)
                return(0x00, 0x40)
            }
        }
        if (m == Mode.LengthPastEnd) {
            assembly {
                mstore(0x00, 0x20)
                mstore(0x20, 0x100)
                return(0x00, 0x40)
            }
        }
        if (m == Mode.Oversized) {
            assembly {
                mstore(0x00, 0x20)
                mstore(0x20, 0x200)
                return(0x00, 0x240)
            }
        }
        return _handles[account];
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        _misbehave();
        if (mode == Mode.DirtyAddress) {
            address o = _owners[keccak256(bytes(handle))];
            assembly {
                mstore(0x00, or(o, shl(160, 1)))
                return(0x00, 0x20)
            }
        }
        return _owners[keccak256(bytes(handle))];
    }

    function _misbehave() private view {
        Mode m = mode;
        if (m == Mode.Revert) revert("registry down");
        if (m == Mode.BurnGas) {
            uint256 i;
            while (gasleft() > 0) {
                unchecked {
                    ++i;
                }
            }
        }
    }
}
