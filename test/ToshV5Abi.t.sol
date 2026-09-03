// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury, IToshFactoryRegistry, IToshHookPoolKey, IToshHookTwap} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchpadHook, IToshFactoryHalt, IToshLadderTreasury} from "../src/ToshLaunchpadHook.sol";

/// @notice Guards against a stale `soat-frontend/src/app/lib/abis.ts`.
///
///         A stale ABI fails quietly — wagmi encodes a call against a
///         signature the deployed contract no longer has, and the user sees an
///         opaque revert at the wallet prompt.  `extractAbis.js`
///         overwrites unconditionally, so "the script ran" is not evidence the
///         checked-in file was ever in sync.  This is.
///
///         How to fix when this fails:
///             forge build
///             node scripts/extractAbis.js
contract ToshV5AbiTest is Test {
    function test_factoryAbi_inSyncWithArtifact() public view {
        _assertAbiInSync("out/ToshFactory.sol/ToshFactory.json", "export const FACTORY_ABI =");
    }

    function test_hookAbi_inSyncWithArtifact() public view {
        _assertAbiInSync("out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json", "export const HOOK_ABI =");
    }

    function test_treasuryAbi_inSyncWithArtifact() public view {
        _assertAbiInSync("out/ToshLadderTreasury.sol/ToshLadderTreasury.json", "export const TREASURY_ABI =");
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @dev `extractAbis.js` emits `JSON.stringify(artifact.abi, null, 2)`, and
    ///      a JSON.parse -> JSON.stringify round trip preserves key order and
    ///      values exactly.  Indentation is therefore the ONLY legitimate
    ///      difference between the two arrays, so normalising whitespace makes
    ///      a byte comparison the right test.
    function _assertAbiInSync(string memory artifactPath, string memory tsAnchor) internal view {
        bytes memory fromArtifact = _extractJsonArray(bytes(vm.readFile(artifactPath)), bytes('"abi":'));

        bytes memory tsFile = bytes(vm.readFile("soat-frontend/src/app/lib/abis.ts"));
        bytes memory fromFrontend = _extractJsonArray(tsFile, bytes(tsAnchor));

        require(
            keccak256(_stripWhitespace(fromArtifact)) == keccak256(_stripWhitespace(fromFrontend)),
            "abis.ts is OUT OF SYNC with the Foundry artifacts. Run: node scripts/extractAbis.js"
        );
    }

    /// @dev Returns the bracket-balanced JSON array that follows `anchor`.
    ///      String-aware: `"uint256[]"` and friends put brackets inside string
    ///      literals, so a naive depth counter would terminate early.
    function _extractJsonArray(bytes memory src, bytes memory anchor) internal pure returns (bytes memory) {
        uint256 i = _indexOf(src, anchor) + anchor.length;

        while (i < src.length && src[i] != "[") {
            ++i;
        }
        require(i < src.length, "no array after anchor");

        uint256 start = i;
        uint256 depth;
        bool inString;
        bool escaped;

        for (; i < src.length; ++i) {
            bytes1 c = src[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == "\\") {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }

            if (c == '"') {
                inString = true;
            } else if (c == "[") {
                ++depth;
            } else if (c == "]") {
                --depth;
                if (depth == 0) return _slice(src, start, i + 1);
            }
        }
        revert("unterminated JSON array");
    }

    /// @dev Drops whitespace that sits OUTSIDE string literals, leaving the
    ///      space in values like `"struct PoolKey"` intact.
    function _stripWhitespace(bytes memory src) internal pure returns (bytes memory out) {
        bytes memory buf = new bytes(src.length);
        uint256 n;
        bool inString;
        bool escaped;

        for (uint256 i; i < src.length; ++i) {
            bytes1 c = src[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == "\\") {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
            } else {
                if (c == '"') {
                    inString = true;
                } else if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) {
                    continue;
                }
            }

            buf[n++] = c;
        }

        out = new bytes(n);
        for (uint256 k; k < n; ++k) {
            out[k] = buf[k];
        }
    }

    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        require(needle.length != 0 && haystack.length >= needle.length, "bad needle");

        for (uint256 i; i <= haystack.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return i;
        }
        revert("anchor not found");
    }

    function _slice(bytes memory src, uint256 start, uint256 end) internal pure returns (bytes memory out) {
        out = new bytes(end - start);
        for (uint256 k; k < end - start; ++k) {
            out[k] = src[start + k];
        }
    }
}

/// @notice Pins the five duck-typed interfaces the three contracts call each
///         other through to the implementations that answer them.
///
///         `ToshLaunchpadHook`, `ToshLadderTreasury` and `ToshFactory` cannot
///         import each other — the factory already imports the hook in order to
///         deploy it, so any reverse import closes a cycle.  Each side therefore
///         redeclares the slice of its counterpart it needs as a local
///         interface and casts a bare address to it.  A cast compiles against
///         ANY address, so nothing in the build checks that the declaration and
///         the implementation still agree; drift surfaces only as a revert on a
///         live pool.
///
///         Slither's `missing-inheritance` names three of these (see
///         `docs/SECURITY_AUDIT.md` §5.7).  Inheriting the interfaces would be
///         the compiler-enforced fix, but it perturbs the hook implementation's
///         creation code, which moves the implementation address on redeploy —
///         and the implementation address is inside the EIP-1167 clone initcode
///         every salt is mined against.  So it cannot be done without a factory
///         redeploy.  Pinning the selectors buys the same guarantee for free.
///
///         `IToshHookTwap` is why this is worth a test rather than a comment.
///         `_buybackSqrtFloor` wraps that call in `try/catch` and returns
///         `MIN_SQRT_PRICE + 1` — an unbounded floor — from the catch.  A drift
///         there does not revert the buyback, it silently strips the slippage
///         bound off every Tosh pool at once.
contract ToshV5InterfaceSelectorTest is Test {
    function test_hookReadsTheTreasuryItActuallyImplements() public pure {
        assertEq(
            IToshLadderTreasury.autoPiggybackBuyback.selector,
            ToshLadderTreasury.autoPiggybackBuyback.selector,
            "IToshLadderTreasury.autoPiggybackBuyback has drifted from ToshLadderTreasury"
        );
        assertEq(
            IToshLadderTreasury.piggybackActive.selector,
            ToshLadderTreasury.piggybackActive.selector,
            "IToshLadderTreasury.piggybackActive has drifted from ToshLadderTreasury"
        );
    }

    function test_hookReadsTheFactoryHaltItActuallyImplements() public pure {
        assertEq(
            IToshFactoryHalt.ladderMintingHalted.selector,
            ToshFactory.ladderMintingHalted.selector,
            "IToshFactoryHalt.ladderMintingHalted has drifted from ToshFactory"
        );
    }

    /// @dev The one whose drift is silent rather than loud.
    function test_treasuryReadsTheHookTwapItActuallyImplements() public pure {
        assertEq(
            IToshHookTwap.twapSqrtPriceX96.selector,
            ToshLaunchpadHook.twapSqrtPriceX96.selector,
            "IToshHookTwap.twapSqrtPriceX96 has drifted from ToshLaunchpadHook -- buybacks would "
            "fall into the catch branch and run with an UNBOUNDED price floor"
        );
    }

    function test_treasuryReadsTheHookPoolKeyItActuallyImplements() public view {
        assertEq(
            IToshHookPoolKey.getPoolKey.selector,
            ToshLaunchpadHook.getPoolKey.selector,
            "IToshHookPoolKey.getPoolKey has drifted from ToshLaunchpadHook"
        );
        assertEq(
            IToshHookPoolKey.launched.selector,
            _hook().launched.selector,
            "IToshHookPoolKey.launched has drifted from ToshLaunchpadHook's public getter"
        );
    }

    function test_treasuryReadsTheFactoryRegistryItActuallyImplements() public view {
        assertEq(
            IToshFactoryRegistry.registeredHooks.selector,
            _factory().registeredHooks.selector,
            "IToshFactoryRegistry.registeredHooks has drifted from ToshFactory's public getter"
        );
        assertEq(
            IToshFactoryRegistry.tokenToHook.selector,
            _factory().tokenToHook.selector,
            "IToshFactoryRegistry.tokenToHook has drifted from ToshFactory's public getter"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @dev `Contract.member.selector` does not reach a public state variable's
    ///      generated getter, only a declared function, so the three getters
    ///      above have to be named through a typed reference instead.  Nothing
    ///      is deployed or called: `.selector` is a compile-time constant, and
    ///      the zero address never leaves these expressions.
    function _hook() private view returns (ToshLaunchpadHook) {
        return ToshLaunchpadHook(payable(address(0)));
    }

    function _factory() private view returns (ToshFactory) {
        return ToshFactory(payable(address(0)));
    }
}
