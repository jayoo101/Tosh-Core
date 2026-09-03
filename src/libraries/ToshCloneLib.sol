// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  ToshCloneLib
/// @notice Deploys a project's two contracts as EIP-1167 minimal proxies rather
///         than as fresh copies: the hook as a 121-byte proxy carrying its
///         per-project configuration in its own bytecode, and the token as the
///         canonical 45-byte proxy with no arguments at all.
///
/// ── Why ─────────────────────────────────────────────────────────────────────
///
///   `createLaunch` measured 5,016,031 gas, of which **91.6 % was code deposit**
///   at 200 gas/byte: 3,917,200 for the hook and 677,400 for the token. Every
///   other cost in the call — CREATE2 base, the keccak over a 21 KB initcode,
///   the factory's own storage writes — summed to 421,431.
///
///   So the only lever that matters is bytes-per-project, and it is the whole
///   lever. This library takes the hook's share from 3,917,200 to 24,200 and the
///   token's from 677,400 to 9,000.
///
/// ── Why a proxy and not a singleton hook ────────────────────────────────────
///
///   A single hook serving every pool is the *native* V4 pattern (every callback
///   carries a `PoolKey`) and would save the same gas. It was rejected because
///   it pools custody: every project's genesis ETH would sit in one contract,
///   and a bug in the shelf-ladder maths could reach deposits belonging to an
///   unrelated round. `invariant_unlaunchedHookCanPayEveryRefund` would degrade
///   from "each hook can independently cover its own depositors" to a far weaker
///   aggregate statement.
///
///   The risk this library adds instead is an offset bug — deterministic,
///   testable, and gone once tested. The risk the singleton adds is structural
///   and no amount of testing removes it. For a contract that custodies user
///   deposits that is not a close call.
///
/// ── What this is NOT ────────────────────────────────────────────────────────
///
///   **These proxies are not upgradeable.** The implementation address is baked
///   into the clone's own runtime bytecode. There is no admin slot, no
///   `upgradeTo`, no proxy owner, and no storage-slot indirection. Nobody —
///   including the platform owner — can change the logic behind a project's
///   hook after it is deployed. This is EIP-1167, not UUPS, and it introduces
///   none of the governance surface people associate with the word "proxy".
///
/// ── Bytecode layout ─────────────────────────────────────────────────────────
///
///   initcode = 131 bytes:
///
///     [0  .. 9  ]  10 B  creation stub: return the 121 bytes that follow
///     [10 .. 54 ]  45 B  canonical EIP-1167 runtime (delegatecall to impl)
///     [55 .. 130]  76 B  immutable args, copied verbatim into the runtime
///
///   runtime = 121 bytes (0x79), which is what the 200 gas/byte is charged on:
///
///     [0  .. 44 ]  45 B  proxy logic — always exits via RETURN or REVERT, so
///                        execution never reaches the args below
///     [45 .. 64 ]  20 B  creator
///     [65 .. 84 ]  20 B  projectTreasury
///     [85 .. 100]  16 B  softCap        (uint128)
///     [101..116 ]  16 B  perWalletCap   (uint128)
///     [117..120 ]   4 B  genesisDuration (uint32)
///
///   Args are read with `EXTCODECOPY(address(this), …)`. The executing account
///   is always in the EIP-2929 access list, so that is a *warm* access at 100
///   gas plus 3 per word — about 109 gas per read, i.e. the same as a warm
///   SLOAD and 20x cheaper than a cold one. This is the reason the args live in
///   code rather than in storage: it keeps the swap-path reads as cheap as the
///   immutables they replace.
///
/// ── Why fixed-width and not Solady's variable-length clone ──────────────────
///
///   Our argument set is a fixed struct, so the length never has to be encoded
///   or decoded and every offset below is a compile-time constant. That removes
///   the length arithmetic that a general-purpose implementation needs, which is
///   precisely where an offset bug would hide.
///
/// ── Packing safety ──────────────────────────────────────────────────────────
///
///   `softCap` and `perWalletCap` narrow from uint256 to uint128. uint128 holds
///   3.4e20 ETH against a total supply near 1.2e8, so the bound is not a real
///   constraint — but a silent truncation here would hand a project a soft cap
///   of nearly zero, so `deployHook` reverts rather than trusting the margin.
library ToshCloneLib {
    // ─── Runtime layout ───────────────────────────────────────────────────────

    /// @dev Length of the EIP-1167 proxy logic, and therefore the offset at
    ///      which the immutable args begin.
    uint256 internal constant PROXY_LEN = 45;

    uint256 internal constant OFF_CREATOR = PROXY_LEN; // 45
    uint256 internal constant OFF_PROJECT_TREASURY = 65;
    uint256 internal constant OFF_SOFT_CAP = 85;
    uint256 internal constant OFF_PER_WALLET_CAP = 101;
    uint256 internal constant OFF_GENESIS_DURATION = 117;

    uint256 internal constant ARGS_LEN = 76;
    uint256 internal constant RUNTIME_LEN = PROXY_LEN + ARGS_LEN; // 121 = 0x79

    // ─── Errors ───────────────────────────────────────────────────────────────

    error CapTooLargeToPack();
    error DurationTooLargeToPack();
    error CloneDeployFailed();

    // ══════════════════════════════════════════════════════════════════════════
    //  Bare clones — no immutable args (used for the project token)
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `ToshToken` needs no per-project immutable args at all: `factory` is
    // platform-global and stays an immutable on the implementation, and
    // name/symbol are strings that could never fit a fixed-width slot anyway, so
    // they live in storage and are written by `initialize`. What is left is the
    // canonical 45-byte EIP-1167 proxy with nothing appended.
    //
    // That takes the token's code deposit from 677,400 gas to 9,000.

    /// @dev Runtime length of a bare clone: the proxy logic and nothing else.
    uint256 internal constant BARE_RUNTIME_LEN = PROXY_LEN; // 45 = 0x2d

    /// @notice Initcode for an argument-free EIP-1167 proxy (55 bytes).
    ///
    /// @dev Identical to `cloneInitcode` except that the creation stub returns
    ///      0x2d bytes instead of 0x79, and no args follow.  Keeping both in one
    ///      library is deliberate: the 45-byte proxy body is the piece that must
    ///      not diverge, and here there is only one copy of it to be wrong.
    function bareCloneInitcode(address implementation) internal pure returns (bytes memory) {
        return abi.encodePacked(
            //   3d      RETURNDATASIZE      0
            //   602d    PUSH1 0x2d          45 (runtime length)
            //   80      DUP1
            //   600a    PUSH1 0x0a          10 (offset of runtime in this code)
            //   3d      RETURNDATASIZE      0
            //   39      CODECOPY            mem[0:45] = code[10:55]
            //   81      DUP2                0
            //   f3      RETURN              return mem[0:45]
            hex"3d602d80600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    /// @notice Deploy a bare clone with CREATE.
    ///
    /// @dev    CREATE, not CREATE2: unlike a hook, a token address carries no V4
    ///         permission bits, so nothing needs to predict or mine it.  This
    ///         keeps the nonce-derived address the `new ToshToken(...)` it
    ///         replaces already produced.
    function deployBareClone(address implementation) internal returns (address deployed) {
        bytes memory initcode = bareCloneInitcode(implementation);
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
        }
        if (deployed == address(0)) revert CloneDeployFailed();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Hook clones — five immutable args
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Build the full CREATE2 initcode for a project's hook proxy.
    ///
    /// @dev    Every field here is part of the initcode and therefore part of the
    ///         mined address, exactly as the nine constructor arguments were
    ///         before. That is the constraint that decides what may live here:
    ///         a value the creator cannot predict while mining the salt off-chain
    ///         cannot be an immutable arg. It is why `genesisDeadline`
    ///         (`block.timestamp + genesisDuration`) stays in storage and only
    ///         the *duration* is packed.
    ///
    ///         `RUNTIME_LEN` is 121, which fits a single PUSH1 — the creation
    ///         stub below hard-codes `0x79`. Changing `ARGS_LEN` past 210 would
    ///         need a PUSH2 stub, so the assertion is worth stating: the encoded
    ///         length and the constant must agree, and the test suite pins it.
    function cloneInitcode(
        address implementation,
        address creator,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) internal pure returns (bytes memory) {
        if (softCap > type(uint128).max || perWalletCap > type(uint128).max) {
            revert CapTooLargeToPack();
        }
        // The two caps were checked and the duration was not, so it was packed
        // by a bare `uint32(...)` cast that truncates in silence. The risk is
        // not the deployment — `initializeToken` rejects any duration outside
        // its three rungs — but `initcodeHash`, a public view the frontend
        // mines salts against: two different durations hashing the same means a
        // salt mined for the value you passed predicts the address of a launch
        // committed to a different one, with nothing anywhere saying so.
        if (genesisDuration > type(uint32).max) {
            revert DurationTooLargeToPack();
        }

        return abi.encodePacked(
            // ── creation stub (10 B) ──────────────────────────────────────────
            //   3d      RETURNDATASIZE      0
            //   6079    PUSH1 0x79          121 (runtime length)
            //   80      DUP1
            //   600a    PUSH1 0x0a          10  (offset of runtime in this code)
            //   3d      RETURNDATASIZE      0
            //   39      CODECOPY            mem[0:121] = code[10:131]
            //   81      DUP2                0
            //   f3      RETURN              return mem[0:121]
            hex"3d607980600a3d3981f3",
            // ── EIP-1167 proxy logic (45 B) ───────────────────────────────────
            //   copy calldata, DELEGATECALL implementation, bubble result
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            // ── immutable args (76 B) ─────────────────────────────────────────
            creator,
            projectTreasury,
            uint128(softCap),
            uint128(perWalletCap),
            uint32(genesisDuration)
        );
    }

    /// @notice keccak256 of the initcode — the value a salt is mined against.
    function initcodeHash(
        address implementation,
        address creator,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) internal pure returns (bytes32) {
        return keccak256(
            cloneInitcode(implementation, creator, projectTreasury, softCap, perWalletCap, genesisDuration)
        );
    }

    /// @notice CREATE2-deploy the proxy.
    ///
    /// @dev    Reverts rather than returning `address(0)`: the caller's next step
    ///         is to write the new hook into `registeredHooks`, and a silent
    ///         zero there would register the null address as a hook.
    function deployHook(
        bytes32 finalSalt,
        address implementation,
        address creator,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) internal returns (address deployed) {
        bytes memory initcode = cloneInitcode(
            implementation, creator, projectTreasury, softCap, perWalletCap, genesisDuration
        );

        assembly ("memory-safe") {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), finalSalt)
        }
        if (deployed == address(0)) revert CloneDeployFailed();
    }

    // ─── Arg readers (run inside the implementation, under DELEGATECALL) ──────
    //
    // `address(this)` is the CLONE in that context, which is what makes these
    // per-project.
    //
    // Each reader copies a full word starting at its field's offset and shifts
    // the field down. Reads run past `RUNTIME_LEN` on the later fields; that is
    // safe and deterministic because EXTCODECOPY zero-pads beyond code length.
    //
    // Memory 0x00-0x3f is Solidity's documented scratch space, so using it needs
    // no allocation and cannot expand memory.
    //
    // ⚠ CALLED ON THE IMPLEMENTATION DIRECTLY, THESE RETURN GARBAGE, NOT ZERO.
    //
    //   The offsets land inside the implementation's *own* runtime bytecode,
    //   which is ~19 KB of real code, so nothing is out of bounds and nothing is
    //   zero-filled. `argSoftCap()` on the bare implementation measured
    //   108121801507535557083176453790012302178 — a nonsense value that is very
    //   much not zero, and therefore not one that a `> 0` check would reject.
    //
    //   An implementation reachable as itself is thus a fully functional hook
    //   holding an arbitrary configuration. Every implementation using these
    //   readers MUST refuse to execute outside a clone; `ToshLaunchpadHook` does
    //   it with an `address immutable _self` captured at construction and an
    //   `onlyClone` guard, which costs a PUSH and an EQ. See
    //   `test_implementationCannotBeUsedDirectly`.

    function argCreator() internal view returns (address a) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, OFF_CREATOR, 32)
            a := shr(96, mload(0x00))
        }
    }

    function argProjectTreasury() internal view returns (address a) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, OFF_PROJECT_TREASURY, 32)
            a := shr(96, mload(0x00))
        }
    }

    function argSoftCap() internal view returns (uint256 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, OFF_SOFT_CAP, 32)
            v := shr(128, mload(0x00))
        }
    }

    function argPerWalletCap() internal view returns (uint256 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, OFF_PER_WALLET_CAP, 32)
            v := shr(128, mload(0x00))
        }
    }

    function argGenesisDuration() internal view returns (uint256 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, OFF_GENESIS_DURATION, 32)
            v := shr(224, mload(0x00))
        }
    }
}
