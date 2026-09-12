# Verification, by hand and by Sourcify

Generated 2026-09-12 for the deployment at block 61056709 (commit `9b9d9ce`).

## Read this first: Sourcify worked

All five contracts are published on **Sourcify**, which lists chain 4663 as
supported and has no Cloudflare gate. `sourcify.mjs` in this directory did it
unattended and is re-runnable; it skips anything already verified, so running
it again is safe and cheap.

    https://sourcify.dev/server/v2/contract/4663/<ADDRESS>

Sourcify grades each one **`match`**, not `exact_match`. The distinction is
worth stating plainly rather than rounding up: the runtime bytecode matches
byte for byte, and the trailing metadata hash does not. So the executable code
is proven identical to this tree, while the provenance of the appended metadata
blob is not. For anyone reading the contracts to decide whether to trust them,
the first of those is the whole question and the second is bookkeeping.

Blockscout does **not** import from Sourcify on its own — it kept reporting
`is_verified: false` afterwards — but `sourcify` is one of the verification
methods its API advertises, and that method needs no file upload because it
fetches from Sourcify by address. That is the cheap path if the explorer's own
listing still matters. The rest of this file is the expensive path.

## Why the Blockscout part is manual

`forge verify-contract --verify` cannot reach the explorer. Blockscout's API
sits behind a Cloudflare managed challenge that answers `403 Just a moment…`
to every automated client tried: `forge`'s HTTP client, `curl` with a browser
user-agent, .NET `HttpClient`, and node's `fetch`. GET requests pass —
`/api/v2/…/config` returns the 1,657 compiler versions quite happily — and POST
does not, which is Cloudflare applying stricter rules to writes rather than
anything wrong with the payload. Four clients failing identically is what makes
this a property of the endpoint and not a bug in one of them.

A real browser solves the challenge, so the upload has to happen in one. That
is the whole reason this directory exists: everything a browser cannot generate
for itself is here, so the part a human has to do is five uploads and no
thinking.

## The five contracts

Two were deployed by `DeployMainnet.s.sol` directly; the other three were
created inside the factory's constructor (`ToshLaunchpadHook`, `ToshToken`) or
placed through the CREATE2 proxy by `forge script` itself (`HookDeployLib`).
The last one is the one every previous count of a Tosh deploy has missed, so it
is listed explicitly rather than left to be noticed.

| Contract | Address |
|---|---|
| `ToshFactory` | `0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892` |
| `ToshLadderTreasury` | `0x255722226720914eF5B2CD54647f21f584BD4Ea2` |
| `ToshLaunchpadHook` (implementation) | `0xa90CF8118D0bB8228503da84397125dc1F7F03E9` |
| `ToshToken` (implementation) | `0xc4184708CeC5137E969bD5d9351DC4626Bbd094E` |
| `HookDeployLib` | `0x6a02d9801ed36150275e5ac7b228a5f6bf6f28a1` |

## Settings, identical for all five

- Method: **Solidity (Standard JSON input)**
- Compiler: **`v0.8.26+commit.8a97fa7a`** — confirmed present in Blockscout's list
- License: **MIT**
- Optimizer and EVM version are inside the JSON (`enabled: true`, `runs: 200`,
  `evmVersion: cancun`), so do not set them in the form.

## Per contract

Go to `https://robinhoodchain.blockscout.com/address/<ADDRESS>/contract-verification`,
pick Standard JSON input, upload the file, paste the constructor arguments, submit.

### `ToshFactory` — `ToshFactory.std.json`

```
0x0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e409510000000000000000000000009a1a8c7b7d68d391909f02e8bd5b148b4b95b7360000000000000000000000002953957774482efa660921df85a1e7634ccfe27a000000000000000000000000255722226720914ef5b2cd54647f21f584bd4ea2
```

`(poolManager, pogSigner, platformTreasury, ladderTreasury)`

### `ToshLadderTreasury` — `ToshLadderTreasury.std.json`

```
0x0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e409510000000000000000000000004e41cea950cf40fa59774b409988d6f9f399e690
```

`(poolManager, initialOwner)`. The second value is the **deployer**, not the
Safe: ownership was transferred in the same broadcast but `Ownable2Step` leaves
the constructor's owner in the bytecode's history, and verification reproduces
the constructor, not the current state.

### `ToshLaunchpadHook` — `ToshLaunchpadHook.std.json`

```
0x0000000000000000000000008366a39cc670b4001a1121b8f6a443a643e409510000000000000000000000002920ca7e9fcd85491d699e1f9ae2caa65cfb2892000000000000000000000000255722226720914ef5b2cd54647f21f584bd4ea20000000000000000000000002953957774482efa660921df85a1e7634ccfe27a
```

`(poolManager, factory, ladderTreasury, platformFeeRecipient)`. All four were
read back off the deployed implementation before this file was written, so they
are the chain's values rather than an inference about what the library passed.

The `factory` argument is the factory address because `HookDeployLib`'s
`deployImplementation` is an `external` library function and therefore runs
under `DELEGATECALL`, which makes its `address(this)` the factory. That is
worth knowing before assuming the library's own address belongs here.

### `ToshToken` — `ToshToken.std.json`

```
0x0000000000000000000000002920ca7e9fcd85491d699e1f9ae2caa65cfb2892
```

`(factory)`

### `HookDeployLib` — `HookDeployLib.std.json`

No constructor arguments. Leave the field empty.

## When it is done

`SECURITY.md` names Sourcify as the published source of record. If Blockscout
is made to agree as well, that paragraph can drop its caveat about the explorer
specifically. Nothing else depends on verification.
