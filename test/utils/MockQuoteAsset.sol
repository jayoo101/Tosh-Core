// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title  MockQuoteAsset
/// @notice Stands in for WBNB: the ERC20 every raise is denominated in and
///         `currency0` of every pool.
///
/// @dev    18 decimals, hard-coded, matching the hook constructor's assertion.
///         No constructor parameter: a configurable precision would reintroduce
///         the ability to test against the wrong one.
///
///         `deposit` / `withdraw` follow WETH9 so `ToshFactory.depositNative`
///         can wrap against this mock exactly as it does against real WBNB.
///         `mint` stays unrestricted so tests can still conjure balances
///         without funding them in native coin; a minted balance is therefore
///         not backed by this contract's ETH, and `withdraw` of one reverts.
///
/// ── What this does NOT model ─────────────────────────────────────────────────
///
///   Real WBNB's depth. There is no market here, so tests say nothing about
///   whether depositors can source the quote asset at scale. See
///   docs/BNB_QUOTE_MIGRATION_zh.md.
contract MockQuoteAsset is ERC20 {
    constructor() ERC20("Mock WBNB", "mWBNB") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Unrestricted, and paired with `mint` so a test can SET a balance
    ///      rather than only raise one.
    ///
    ///      That distinction is why this exists. The suite used to arm the
    ///      buyback reservoir with `vm.deal(address(ladder), n)`, which assigns.
    ///      `mint` accumulates, so a test that armed the reservoir twice — or
    ///      armed it after a swap had already fed it — would be measuring a
    ///      larger pot than it asked for, and the piggyback tests are precisely
    ///      the ones that turn on whether the pot is one base unit above or below
    ///      `TRIGGER_STEP`. `ToshV5Test._setReservoir` needs both halves.
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
