# 部署当天执行清单（BSC 56 新工厂）

照着从上往下做，每一步都有「看到什么才算完成」；没看到就停下，不要往下走。
背景和每一步的原因见 `GENESIS_FEE_REDEPLOY_zh.md` §7，这里只写命令。

## 已经核对过的（2026-10-08）

| 项目 | 结果 |
|---|---|
| 预检 `preflightMainnet.mjs` | 只有一项不过：部署钱包余额 0（见第 0 步） |
| 本地试跑 `DeployMainnet.s.sol` | 通过；四个角色正确；实测约 23.26M gas，0.05 gwei 下约 0.00116 BNB |
| 主网 fork 全流程演练 | 广播 → 部署钱包暂停 → Safe 批量交接 → `VerifyDeployment` 通过 → Safe 解除暂停 → 各阶段 `redeployTx.mjs check` 全部通过；不设硬顶的 `createLaunch` 在 Safe 身份下模拟通过 |
| PoG 签名地址 | 新旧工厂都是 `0x57565feB…F877`，Vercel 的 `POG_SIGNER_PRIVATE_KEY` 不用动 |
| Safe `0x02DE…B310` | 2/3，签名人 `0x0db9…1c6E`（0.01 BNB）、`0x3b7f…12E6`（0.042 BNB）能付执行 gas |

固定地址：

| | 地址 |
|---|---|
| 部署钱包 | `0x35b232E26a275f62E594e010624aEA0c46b7874a` |
| Safe（owner + 平台收款） | `0x02DE4629129D104C63329D13A6Ca67E43db7B310` |
| 旧工厂 | `0x20dE906A96FfB89BE6fd6267A0876A68017792F7` |
| 旧回购池 | `0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B` |

**预计的新地址**（由部署钱包的 nonce 9 决定；广播前部署钱包不能发任何交易，否则会变）：

| | 地址 |
|---|---|
| 新回购池 | `0x3009e10a696AC43465C8bdb9AFD8C989aB9cebdE` |
| 新工厂 | `0xBCa66f7382aaC0C6EE2b833fc2072CA607367f2c` |
| Circuit NFT | `0x59bE7c25D20e726E41cD088937094CC0970AD14d` |

广播结果里的地址和这张表不一样，不算出错（说明 nonce 变了），但要以广播结果为准。

---

## 第 0 步：给部署钱包打 gas

从你自己的钱包（例如 `0x2869…D814`）向部署钱包 `0x35b2…874a` 转 **0.005 BNB**。
够 0.2 gwei 以内的任何 gas 价格，剩下的部署完可以转回。

完成：

```powershell
cast balance 0x35b232E26a275f62E594e010624aEA0c46b7874a --rpc-url https://bsc-dataseed.bnbchain.org --ether
```

显示 ≥ 0.005。

## 第 1 步：预检

在仓库根目录（有 `foundry.toml` 的那一层）打开一个**新的** PowerShell 窗口，接下来第 2–5 步都在这个窗口里做。

```powershell
node scripts/preflightMainnet.mjs
```

完成：最后一行是全部通过、退出码 0。

## 第 2 步：载入变量和私钥

```powershell
.\scripts\deployday-step1.ps1
```

它会提示粘贴私钥：私钥就是 `.env.testnet-parked` 里 `PRIVATE_KEY=` 后面那串。粘贴时屏幕上不显示，是正常的。

完成：看到 `same wallet`、`TARGET_CHAIN_ID is 56`、`PLATFORM_TREASURY is the owner Safe`，最后一行 `Step 1 done`。

## 第 3 步：试跑（不发交易）

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv
```

完成：输出里

- `Chain ID (verified) : 56`
- `Deployer : 0x35b2…874a`
- `PROD owner : 0x02DE…B310`
- `PoG Signer : 0x5756…F877`
- `Platform fee recipient : 0x02DE…B310`
- `FACTORY_ADDRESS` / `TREASURY_ADDRESS` 和上面的预计地址一致
- 最后是 `SIMULATION COMPLETE`

公共节点偶尔握手失败（`tls handshake eof`），重跑一次即可。

## 第 4 步：广播

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC --broadcast --slow -vvvv
```

**中途断了，不要重跑，改用续传**（重跑会多部署一套）：

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC --broadcast --slow --resume -vvvv
```

完成：`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`。把地址记下来：

```powershell
$factory  = '<输出里的 FACTORY_ADDRESS>'
$treasury = '<输出里的 TREASURY_ADDRESS>'
```

## 第 5 步：部署钱包立刻暂停新工厂，然后清掉私钥

```powershell
cast send $factory "pause()" --rpc-url $env:TARGET_RPC --private-key $env:PRIVATE_KEY
cast call $factory "paused()(bool)" --rpc-url $env:TARGET_RPC
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage deployed
Remove-Item Env:\PRIVATE_KEY
```

完成：`paused()` 是 `true`；`check` 最后是 `all checks passed`。
从这里起部署钱包的工作结束，后面都由 Safe 签。

## 第 6 步：Safe 第一批（暂停旧工厂 + 接受两份所有权）

```powershell
node scripts/redeployTx.mjs handoff --factory $factory --treasury $treasury --out safe-handoff.json
```

完成：三行 `simulated as the Safe … PASS`，写出 `safe-handoff.json`。

然后：

1. 签名人 A 打开 [Safe](https://app.safe.global/home?safe=bnb:0x02DE4629129D104C63329D13A6Ca67E43db7B310) → Apps → **Transaction Builder**。
2. 把 `safe-handoff.json` 拖进去，确认列表里是三笔：
   - 旧工厂 `0x20dE…92F7` 的 `pause()`；
   - 新工厂的 `acceptOwnership()`；
   - 新回购池的 `acceptOwnership()`。
3. 点 Create batch → Send batch → Sign。
4. 签名人 B 进 Transactions → Queue → Confirm → Execute。B 的钱包里要有一点 BNB。

完成：

```powershell
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage handed
$env:EXPECTED_PAUSED='true'; $env:EXPECTED_OWNER='0x02DE4629129D104C63329D13A6Ca67E43db7B310'
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $factory --rpc-url $env:TARGET_RPC
```

两条都通过（`all checks passed`、`ALL CHECKS PASSED`，`Paused? : true`）。

## 第 7 步：把新地址告诉我

我会更新这几个文件，并提交：

- `.env.production`：`FACTORY_ADDRESS`、`LADDER_TREASURY_ADDRESS`、`DEPLOY_BLOCK`、`HOOK_CREATION_CODEHASH`；
- `monitoring/alerts.json`：里面的地址。

这一步不发交易。

## 第 8 步：前端切到新工厂（发射入口仍然关着）

在 `soat-frontend` 目录下：

```powershell
vercel env update NEXT_PUBLIC_FACTORY_ADDRESS production --value $factory --yes
vercel env update NEXT_PUBLIC_TREASURY_ADDRESS production --value $treasury --yes
```

- `NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES` 已经是旧工厂地址，不用动。
- `NEXT_PUBLIC_LAUNCHES_PAUSED` 保持 `1`。

然后在 Vercel → Deployments → 最新的 Production → **Redeploy**（只触发这一次）。

完成：

```powershell
$env:NEXT_PUBLIC_FACTORY_ADDRESS=$factory; npm run check:quote
```

- 上面的检查通过；
- 线上目录里 10 个旧项目都还在；
- `/launch` 仍显示暂停；
- `/apply` 提交一条测试申请能到 Telegram 群。

## 第 9 步：监控同时盯新旧两组

```powershell
$blk = (cast receipt (Get-Content broadcast\DeployMainnet.s.sol\56\run-latest.json -Raw | ConvertFrom-Json).receipts[0].transactionHash blockNumber --rpc-url $env:TARGET_RPC)
gh variable set MONITOR_FACTORY --body $factory
gh variable set MONITOR_TREASURY --body $treasury
gh variable set MONITOR_DEPLOY_BLOCK --body $blk
gh variable set MONITOR_LEGACY_FACTORY --body 0x20dE906A96FfB89BE6fd6267A0876A68017792F7
gh variable set MONITOR_LEGACY_TREASURY --body 0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B
gh variable set MONITOR_LEGACY_EXPECTED_OWNER --body 0x02DE4629129D104C63329D13A6Ca67E43db7B310
gh workflow run watch.yml
```

`MONITOR_EXPECTED_OWNER`（Safe）和 `MONITOR_EXPECTED_POG_SIGNER` 不用改。

完成：这一轮 watch 两组都跑到：

- 新的一组只报预期的 WATCHER-06（「盯的工厂换了」）；
- 旧的一组只报 TOSHX 那条 STATE-01。

## 第 10 步：Safe 第二批（解除新工厂暂停）

```powershell
node scripts/redeployTx.mjs unpause --factory $factory --out safe-unpause.json
```

同第 6 步：拖进 Transaction Builder，签名人 A 签，签名人 B 确认并执行。

完成：

```powershell
node scripts/redeployTx.mjs check --factory $factory --treasury $treasury --stage live
Remove-Item Env:\EXPECTED_PAUSED
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $factory --rpc-url $env:TARGET_RPC
```

两条都通过，`Paused? : false`。

## 第 11 步：打开发射入口

```powershell
vercel env rm NEXT_PUBLIC_LAUNCHES_PAUSED production --yes
```

再在 Vercel 上 Redeploy 一次。

完成：顶栏出现「发射」；`/launch` 显示表单，并提示 owner 是多签、要用脚本发射。

## 第 12 步：第一个项目

例：不设硬顶、单地址 50 BEM、24 小时。

```powershell
node scripts/safeLaunchTx.mjs create --factory $factory --name "项目名" --symbol "TICKER" --developer 0x开发者地址 --hard-cap none --wallet-cap 50 --duration 24h --out safe-create.json
```

- 要设硬顶就把 `none` 换成 BEM 数量，30–20000。
- 脚本会先模拟，全部 PASS 才写文件。
- 文件同样走 Safe Transaction Builder。

募资结束后开池：

```powershell
node scripts/safeLaunchTx.mjs launch --factory $factory --hook 0x钩子地址 --out safe-launch.json
```

---

## 回退

| 做到哪一步 | 能否回退 | 怎么做 |
|---|---|---|
| 第 4 步之前 | 完全可以 | 什么都不用做 |
| 第 4–7 步 | 可以 | 新合约放着不用；旧工厂已暂停的话，Safe 对旧工厂 `unpause()` |
| 第 8–10 步 | 可以 | 把 Vercel 两个地址改回旧的再 Redeploy；新工厂上还没有项目 |
| 第 12 步之后 | 不能 | 新钩子不可变，存款人已经进来 |

## 收尾

部署完成后：

- 部署钱包里剩下的 BNB 可以转回；
- `.env.testnet-parked` 可以删掉。

交接完成后，这把私钥对新合约没有任何权限，只剩测试网合约的 owner 身份。
