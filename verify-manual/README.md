# Publishing the chain 56 source through BscScan's web form

`verify.yml` cannot publish these. The free Etherscan key refuses every
submission on chain 56 with *"Free API access is not supported for this
chain"* — fifteen submissions across three runs on 2026-09-21, no success on
that chain ever. The web form takes no API key and is not subject to that
refusal, so this directory carries what the form asks for.

Generated 2026-09-21 from the tree at the commit that deployed. Regenerate
with `forge verify-contract <addr> <path>:<name> --show-standard-json-input`
if the tree moves — but note the three traps in *Regenerating* below.

## The same for every contract

| Field | Value |
| --- | --- |
| Compiler Type | Solidity (Standard-Json-Input) |
| Compiler Version | `v0.8.26+commit.8a97fa7a` |
| License | MIT (option 3) |

Pick **Standard-Json-Input**, not "Single file". The settings that matter —
`viaIR: true`, optimizer on at 200 runs, `evmVersion: cancun` — live inside
the JSON. The single-file flow asks for them as form fields instead, `viaIR`
is not among those fields, and without it the bytecode cannot match.

This link lands straight on step 2 with all four step-1 fields preset:

    https://bscscan.com/verifyContract-solc-json?a=<ADDRESS>&c=v0.8.26%2bcommit.8a97fa7a&lictype=3

Then: upload the JSON, paste the arguments, wait for the Cloudflare widget to
say Success, and submit. There is no library-address field anywhere in this
flow — for Standard-Json-Input the explorer takes libraries only from
`settings.libraries` inside the file, which is why `ToshFactory.json` has it
patched in.

Status as of 2026-09-21: `ToshToken` published. `HookDeployLib` cannot be —
see its entry below.

## Per contract

Constructor arguments go in the form's *Constructor Arguments ABI-encoded*
field, **without** a leading `0x`. Full values are in
`constructor-args.txt`; they are truncated here for reading.

### ToshFactory — `0x20dE906A96FfB89BE6fd6267A0876A68017792F7`

- Upload `ToshFactory.json`
- Args: `000000…058b` + 5 more addresses (`constructor-args.txt`)
- **Library**: already patched into `settings.libraries` in the JSON, so the
  form needs nothing extra. This is the one that would otherwise fail: forge
  emits `settings.libraries` as `{}` even though `ToshFactory` links
  `HookDeployLib`, and an unlinked placeholder reports as a plain bytecode
  mismatch with no mention of libraries.

### ToshLadderTreasury — `0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B`

- Upload `ToshLadderTreasury.json`
- Args: 4 addresses. The third is the **deploying EOA**
  `0x35b232…7874a`, not the current `owner()` — ownership moved to the Safe
  after construction, so the live getter is the wrong value here.

### ToshLaunchpadHook — `0x1a219137Ef0FeD2cC7B1BFc0B01e16f13a681653`

- Upload `ToshLaunchpadHook.json`
- Args: 6 addresses

### ToshToken — `0x9126c5D83fe03c3C3A226fB7C41b60c1028d8031`

- Upload `ToshToken.json`
- Args: 1 address, the factory

### HookDeployLib — `0x96076c1cdb92bd85d6af4e4bb948f92bf9009dfe`

**This one does not verify, and the materials are not why.** Submitting it
returns *"Unable to find matching Contract Bytecode and ABI"*. Measured
2026-09-21, before concluding anything:

- The **creation** code matches byte for byte. The CREATE2 payload is a
  32-byte zero salt followed by exactly the artifact's init code.
- The **runtime** code differs in 20 bytes and nothing else — not even the
  trailing CBOR metadata hash, which means the source set and every compiler
  setting are right.
- Those 20 bytes are at offsets 166–185, inside
  `immutableReferences: {"library_deploy_address": [{"start":154,"length":32}]}`.
  Under `viaIR`, solc gives a library its own address as an immutable written
  at construction by `ADDRESS`, so a recompilation can only ever produce
  zeros there.

It was deployed by the deterministic CREATE2 deployer
`0x4e59b448…4956c`, so there is no standalone creation transaction for the
explorer to compare against and it falls back to the runtime code, where that
immutable defeats the match. Re-submitting cannot change any of this.

Leaving it unverified costs little: `HookDeployLib.sol` is one of the 71
sources inside `ToshFactory.json`, so once the factory is published the
library's source is readable there. `ToshFactory` needs the library's
*address*, not its verified status, and that is already in the JSON.

## Where the arguments came from

`ToshFactory` and `ToshLadderTreasury` were stripped off the creation payload
in the broadcast log, so they are what the chain actually received rather than
what the deploy script recorded as intending to pass.

`ToshLaunchpadHook` and `ToshToken` are built inside `ToshFactory`'s
constructor and have no creation transaction to strip, so theirs were
re-encoded from the factory's immutable getters. That is a derivation, and it
was checked: all seven values were read back from the two implementations'
own immutables — set by the very constructor call in question — and all seven
matched.

## Regenerating

Three failure modes here are silent, and none of them produce an error that
names the cause:

1. `--show-standard-json-input` makes no network call but still aborts with
   `environment variable ETHERSCAN_API_KEY not found`, because
   `foundry.toml`'s `[etherscan]` table interpolates it and that table is
   resolved whenever the config is read. Any placeholder value works.
2. PowerShell's `>` writes UTF-16LE and `Out-File` prepends a BOM. Either
   makes a file the form will not parse. Capture stdout in something that
   writes plain UTF-8.
3. The PowerShell pipe truncated the largest of these files part-way. A
   truncated file has a plausible size in a directory listing; parse each one
   after writing it.
