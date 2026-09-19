// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title  MockQuoteAsset
/// @notice Stands in for BEM: the ERC20 every raise is denominated in and
///         `currency0` of every pool.
///
/// @dev    SEPARATE FROM `MockERC20` ON PURPOSE, and the reason is the whole
///         point of this file: `decimals()` returns 8.
///
///         `MockERC20` is 18 decimals — it was written as mock SATO, back when
///         the quote asset was native and the only ERC20 in a test was a project
///         token. Reusing it here would compile, deploy, and pass a great many
///         tests, because almost nothing in the protocol reads `decimals()`. The
///         one thing that does is the hook's constructor, which asserts 8.
///
///         What would break silently if that assertion were ever relaxed is the
///         shelf ladder. `p0 = lpQuote * 1e18 / GENESIS_LP_SUPPLY`, shelves are
///         geometric at +0.19025%, and monotonicity needs `shelfP0 >= 526` or
///         adjacent shelves round onto the same price. At 18 decimals a 100-unit
///         raise clears that by sixteen million to one; at 8 it clears it by
///         4.75. A test suite running on an 18-decimal mock would therefore be
///         measuring a ladder with effectively infinite headroom while production
///         runs one with almost none — and every granularity test would pass for
///         the wrong reason.
///
///         So: 8 decimals, hard-coded, no constructor parameter. A configurable
///         precision would reintroduce exactly the ability to test against the
///         wrong one.
///
/// ── What this does NOT model ─────────────────────────────────────────────────
///
///   Two properties of real BEM are absent here, and neither can be mocked into
///   existence. Tests that pass against this contract say nothing about either.
///
///     1. SUPPLY. `mint` is unrestricted and free, so any test can conjure any
///        amount. Real BEM's total supply is 191,739.22 tokens, which is 206x
///        the 928.4-token default soft cap — so one raise at the default is
///        0.48% of everything in existence.
///
///     2. DEPTH. There is no market here at all. Real BEM's only pool of
///        consequence held 1,959 tokens, so a 928.4-token raise asks for roughly
///        half the float, and depositors cannot buy their way in at scale.
///
///   Both are in docs/BEM_QUOTE_ASSET.md §1.2. They are product problems rather
///   than code problems, which is precisely why no test will surface them.
contract MockQuoteAsset is ERC20 {
    constructor() ERC20("Mock BEM", "mBEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
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
