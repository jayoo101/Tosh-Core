// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  WalletLib
/// @notice What ToshX accepts as a wallet before launch: an address with no
///         code, or an EOA carrying an EIP-7702 delegation.
///
/// @dev    A 7702 account's code is exactly `0xef0100 ‖ delegate` (23 bytes),
///         and EXTCODESIZE / EXTCODECOPY read that designator rather than the
///         delegate. Accepting it is safe here because every pre-launch rule
///         that moves tokens also requires the account to be `tx.origin`, so
///         delegate code can only ever run on its owner's own signature.
library WalletLib {
    function isWallet(address account) internal view returns (bool ok) {
        assembly ("memory-safe") {
            switch extcodesize(account)
            case 0 { ok := 1 }
            case 23 {
                let ptr := mload(0x40)
                extcodecopy(account, ptr, 0, 3)
                ok := eq(shr(232, mload(ptr)), 0xef0100)
            }
            default { ok := 0 }
        }
    }
}
