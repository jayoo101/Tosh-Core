// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Fee-on-transfer / deflationary ERC-20 mock used to verify
///         that ToshLaunchpadHook's delta-based accounting is robust
///         against tokens that siphon a percentage on every transfer.
///
///         The fee is gated behind a runtime flag so the same token can
///         participate in flows that don't tolerate FoT shrinkage (e.g.
///         V4 pool settlement during `launch()`).  Tests should:
///
///           1. Deploy with `feeEnabled = false`.
///           2. Bootstrap the launch normally.
///           3. Flip `setFeeEnabled(true)` immediately before exercising
///              the function under test (e.g. `mintBondingCurve`).
contract FoTMockERC20 is ERC20 {
    /// @notice Where the siphoned fee is routed.
    address public immutable feeSink;

    /// @notice Fee rate in basis points (100 BPS = 1 %).
    uint256 public immutable feeBps;

    /// @notice Master switch — when false the token behaves like a vanilla ERC-20.
    bool public feeEnabled;

    constructor(string memory name_, string memory symbol_, uint256 _feeBps, address _feeSink) ERC20(name_, symbol_) {
        // Allow exactly 100 % siphon (10 000 BPS) for the
        // `FeeTransferFailed` / `ZeroReceived` negative paths in the test
        // suite.  Above 100 % is rejected — would produce negative receiver
        // amounts and revert in `_update` anyway.
        require(_feeBps <= 10_000, "fee > 100%");
        require(_feeSink != address(0), "zero feeSink");
        feeBps = _feeBps;
        feeSink = _feeSink;
    }

    /// @notice Open mint for test setup convenience.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Toggle the FoT behaviour.
    function setFeeEnabled(bool on) external {
        feeEnabled = on;
    }

    /// @dev Apply the fee on every user-to-user transfer when the switch is on.
    ///      Mints (`from == 0`) and burns (`to == 0`) are always fee-free so
    ///      this mock can compensate test-side balance gaps deterministically.
    function _update(address from, address to, uint256 value) internal override {
        if (!feeEnabled || from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        if (fee > 0) {
            super._update(from, feeSink, fee);
        }
        super._update(from, to, value - fee);
    }
}
