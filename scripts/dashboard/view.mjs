/**
 * HTML for the dashboard.
 *
 * Server-rendered on each request with no client-side JavaScript beyond a meta
 * refresh. Everything on the page is read with credentials that live on this
 * machine, so there is nothing to gain from shipping a client that could fetch
 * it again — and a page that cannot make requests cannot leak a key.
 */

import { ethers } from 'ethers'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
))

const units = (v, d, places = 4) => Number(ethers.formatUnits(BigInt(v ?? 0), d))
  .toLocaleString('en-US', { maximumFractionDigits: places })

const pct = (f, places = 2) => f === null || f === undefined ? '—' : `${(f * 100).toFixed(places)}%`
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`
const bscan = (a, kind = 'address') => `https://bscscan.com/${kind}/${a}`

/** A panel that could not be filled says what it needs, not zero. */
function unavailable(p) {
  return `<div class="miss">
    <strong>无法采集</strong>
    ${p.needs ? `<div>需要 <code>${esc(p.needs)}</code></div>` : ''}
    <div class="dim">${esc(p.error || '')}</div>
  </div>`
}

function panel(title, subtitle, body) {
  return `<section>
    <h2>${esc(title)}<span class="sub">${esc(subtitle)}</span></h2>
    ${body}
  </section>`
}

/** A severity marker. Only three states so the page cannot become all-warning. */
const flag = (level, text) => `<span class="flag ${level}">${esc(text)}</span>`

function funnelPanel(f, QD) {
  if (!f.ok) return panel('漏斗', '扫描 → 过门槛 → 投钱', unavailable(f))

  const r = f.recent
  const eligibleRate = r && !r.error && r.scanned > 0 ? r.eligible / r.scanned : null

  // The distribution is what makes the floor decision. Bucketing by how far
  // below the floor a wallet sits distinguishes "nearly qualified" from
  // "nowhere near", which call for opposite decisions.
  let buckets = ''
  if (r && !r.error && r.totals?.length) {
    const floor = Number(BigInt(f.band.floorWei))
    const edges = [
      ['≥ 门槛（合格）', (t) => t >= floor],
      ['门槛的 50–100%', (t) => t >= floor * 0.5 && t < floor],
      ['门槛的 10–50%', (t) => t >= floor * 0.1 && t < floor * 0.5],
      ['门槛的 1–10%', (t) => t >= floor * 0.01 && t < floor * 0.1],
      ['< 门槛的 1%', (t) => t < floor * 0.01],
    ]
    const nums = r.totals.map(Number)
    buckets = `<table><tr><th>近 48h 扫描的 gas 分布</th><th>钱包</th><th></th></tr>${
      edges.map(([label, test]) => {
        const n = nums.filter(test).length
        const w = nums.length ? Math.round((n / nums.length) * 100) : 0
        return `<tr><td>${esc(label)}</td><td class="num">${n}</td><td><div class="bar" style="width:${w}%"></div></td></tr>`
      }).join('')
    }</table>`
  }

  return panel('漏斗', '扫描 → 过门槛 → 投钱', `
    <div class="steps">
      <div class="step">
        <div class="k">扫描尝试</div>
        <div class="v">${f.attempts?.error ? '—' : (f.attempts?.total ?? '—')}</div>
        <div class="dim">${f.attempts?.error ? esc(f.attempts.error) : `${f.attempts?.windows ?? 0} 个小时窗口内`}</div>
      </div>
      <div class="arrow">→</div>
      <div class="step">
        <div class="k">过门槛并注册配额</div>
        <div class="v">${f.registered}</div>
        <div class="dim">${f.registrations} 次注册（可重复提升）</div>
      </div>
      <div class="arrow">→</div>
      <div class="step">
        <div class="k">真的投了钱</div>
        <div class="v">${f.depositors}</div>
        <div class="dim">${f.deposits} 笔，共 ${units(f.depositTotal, QD, 2)} BEM</div>
      </div>
    </div>

    <table>
      <tr><td>过门槛后的转化率</td><td class="num">${pct(f.depositConversion)}</td>
          <td class="dim">允许进来的人里，有多少真的来了</td></tr>
      <tr><td>近 48h 合格率</td>
          <td class="num">${eligibleRate === null ? '—' : pct(eligibleRate)}</td>
          <td class="dim">${r?.error ? esc(r.error) : r ? `${r.eligible}/${r.scanned} 个扫描过的钱包${r.truncated ? '（键空间被截断）' : ''}` : '需要 Upstash'}</td></tr>
      <tr><td>被 maxAlloc 上限截断</td><td class="num">${f.atCeiling} / ${f.registered}</td>
          <td class="dim">${f.atCeiling > 0 && f.atCeiling === f.registered
            ? flag('warn', '全部顶到上限 —— 门槛偏松，上限才是真正的约束')
            : f.atCeiling === 0 && f.registered > 0
              ? flag('warn', '没有人顶到上限 —— 约束来自门槛，不是上限')
              : '上限之下仍有区分度'}</td></tr>
      <tr><td>配额中位数</td><td class="num">${units(f.quotaMedian, QD, 2)}</td><td class="dim">BEM</td></tr>
      <tr><td>配额总额</td><td class="num">${units(f.quotaTotal, QD, 2)}</td><td class="dim">BEM，全平台已授予</td></tr>
      <tr><td>带推荐人的出资</td><td class="num">${f.referredDeposits} / ${f.deposits}</td><td class="dim">推荐渠道贡献</td></tr>
      <tr><td>当前门槛</td><td class="num">${units(f.band.floorWei, 18, 4)} ETH</td>
          <td class="dim">等值终身 gas 消耗 · ${esc(f.band.source)}</td></tr>
    </table>
    ${buckets}
  `)
}

function poolPanel(pools, QD, TD) {
  const body = pools.map((p) => {
    if (!p.ok) return unavailable(p)
    const need = p.depthFor1PctAt25
    return `
      <h3>${esc(p.symbol)} <span class="dim">${esc(p.name)}</span>
        <a href="${bscan(p.token, 'token')}" target="_blank">${short(p.token)}</a></h3>
      <table>
        <tr><td>现价</td><td class="num">${p.spot.toPrecision(6)}</td><td class="dim">BEM / ${esc(p.symbol)}</td></tr>
        <tr><td>池内深度</td><td class="num">${p.depthQuote.toLocaleString('en-US', { maximumFractionDigits: 0 })} BEM</td>
            <td class="dim">配 ${p.depthToken.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${esc(p.symbol)}</td></tr>
        <tr><td>真实 swap 费</td><td class="num">${(p.swapFeePips / 10000).toFixed(4)}%</td>
            <td class="dim">${p.lpFee} LP + ${p.protocolFee} 协议 pips，复合而非相加</td></tr>
        <tr><td>25 BEM 来回成本</td><td class="num">${pct(p.roundTripAt25, 3)}</td>
            <td class="dim">两次 1% 暗税 + 两次池子费 + 冲击</td></tr>
      </table>
      <table>
        <tr><th>买入规模</th><th>价格冲击</th><th></th></tr>
        ${p.curve.map((c) => {
          const w = Math.min(100, Math.round(c.impact * 100 * 10))
          const lvl = c.impact > 0.05 ? 'bad' : c.impact > 0.01 ? 'warn' : 'ok'
          return `<tr><td>${c.quote} BEM</td>
            <td class="num ${lvl}">${pct(c.impact, 2)}</td>
            <td><div class="bar ${lvl}" style="width:${w}%"></div></td></tr>`
        }).join('')}
      </table>
      <p class="note">${need === null
        ? '25 BEM 的冲击已在 1% 以内，深度充足。'
        : `插针来自深度不足，不是成交量不足。要把 25 BEM 的冲击压到 1% 以内，还需要再加约 <strong>${need.toLocaleString('en-US', { maximumFractionDigits: 0 })} BEM</strong> 的等值流动性（双边）。加 LP 不付那 ${pct(p.roundTripAt25, 2)} 的来回成本，反而收 ${(p.lpFee / 10000).toFixed(2)}% 的池子费。`}</p>
    `
  }).join('<hr>')

  return panel('池子健康度', 'K 线为什么难看', body || '<div class="miss">没有已发射的项目</div>')
}

function burnPanel(b, QD, TD) {
  if (!b.ok) return panel('销毁与回购', '归因：回购买盘 vs 卖出税', unavailable(b))

  const skipAlarm = b.skippedCount > 0
    ? flag(b.skippedCount > b.buybackCount ? 'bad' : 'warn', `${b.skippedCount} 次跳过`)
    : flag('ok', '无跳过')

  /**
   * With no event history there is no attribution, and saying so is the whole
   * point of this branch. Every buyback total would read zero, which would make
   * the residual — sell-tax burn — absorb the entire dead-address balance and
   * assert that no buyback has ever happened. That is not a degraded answer,
   * it is a false one, so the attribution rows are withheld rather than shown.
   */
  const attributionAvailable = !b.logsError

  return panel('销毁与回购', '归因：回购买盘 vs 卖出税', `
    ${b.logsError ? `<div class="miss"><strong>归因不可用</strong>
      <div>拿不到事件历史，无法区分"回购销毁"和"卖出税销毁"。下面只显示金库实时状态和总销毁量。</div>
      <div class="dim">${esc(b.logsError)}</div></div>` : ''}
    <table>
      <tr><td>金库余量 reservoir</td><td class="num">${units(b.reservoir, QD, 2)}</td><td class="dim">BEM</td></tr>
      <tr><td>已武装的代币</td><td class="num">${b.ladderCount}</td>
          <td class="dim">${b.ladderCount === 0 ? flag('bad', '一个都没加 —— 回购不会执行') : '在回购名单内'}</td></tr>
      <tr><td>距下次触发</td><td class="num">${units(b.untilNextTrigger, QD, 2)}</td>
          <td class="dim">BEM，触发步长 ${units(b.triggerStep, QD, 1)}</td></tr>
      <tr><td>下次投入</td><td class="num">${units(b.nextSpendAmount, QD, 2)}</td><td class="dim">BEM</td></tr>
      ${attributionAvailable ? `
      <tr><td>已执行回购</td><td class="num">${b.buybackCount}</td>
          <td class="dim">共投入 ${units(b.buybackSpent, QD, 2)} BEM</td></tr>
      <tr><td>回购跳过</td><td class="num">${b.skippedCount}</td><td>${skipAlarm}
          <span class="dim">跳过意味着有钱但没买成（TWAP 偏离、深度不足或滑点超限）</span></td></tr>` : ''}
    </table>

    ${b.tokens.map((t) => `
      <h3>${esc(t.symbol)} ${t.armed ? flag('ok', '已武装') : flag('bad', '未加入回购名单')}</h3>
      <table>
        <tr><td>总销毁</td><td class="num">${units(t.deadBalance, TD, 0)}</td>
            <td class="dim">占总供应 ${pct(t.burnedFraction, 3)}</td></tr>
        ${attributionAvailable ? `
        <tr><td>其中 · 回购销毁</td><td class="num">${units(t.buybackBurned, TD, 0)}</td>
            <td class="dim">${t.buybackCount} 笔，花掉 ${units(t.buybackSpent, QD, 2)} BEM —— 这是真实买盘</td></tr>
        <tr><td>其中 · 卖出税销毁</td><td class="num">${units(t.sellTaxBurned, TD, 0)}</td>
            <td class="dim">${BigInt(t.sellTaxBurned) < 0n
              ? flag('bad', '负数 —— 归因对不上，需要查')
              : '只减供应，没有买盘'}</td></tr>` : ''}
        <tr><td>总供应</td><td class="num">${units(t.totalSupply, TD, 0)}</td>
            <td class="dim">会随二阶段货架铸币增长</td></tr>
      </table>`).join('')}

    ${b.recent.length ? `<table><tr><th>最近回购</th><th>投入 BEM</th><th>销毁代币</th><th></th></tr>
      ${b.recent.map((r) => `<tr>
        <td class="dim">#${r.block}</td>
        <td class="num">${units(r.nativeIn, QD, 4)}</td>
        <td class="num">${units(r.tokensBurned, TD, 0)}</td>
        <td><a href="${bscan(r.tx, 'tx')}" target="_blank">${short(r.tx)}</a></td>
      </tr>`).join('')}</table>` : ''}
  `)
}

function moneyPanel(m, QD) {
  if (!m.ok) return panel('资金去向', '四个不同的目的地', unavailable(m))
  return panel('资金去向', '四个不同的目的地', `
    <table>
      <tr><th>去处</th><th>余额</th><th>来源</th></tr>
      <tr><td><a href="${bscan(m.platformTreasury)}" target="_blank">平台 Safe</a> ${short(m.platformTreasury)}</td>
          <td class="num">${units(m.safeQuote, QD, 4)} BEM</td>
          <td class="dim">买入额的 0.30% 平台维护费</td></tr>
      <tr><td>同一个 Safe（原生币）</td>
          <td class="num">${units(m.safeNative, 18, 4)} BNB</td>
          <td class="dim">每次发射的 launchFee，当前 ${units(m.launchFee, 18, 4)} BNB</td></tr>
      <tr><td><a href="${bscan('0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B')}" target="_blank">阶梯金库</a>（合约，非钱包）</td>
          <td class="num">${units(m.treasuryQuote, QD, 4)} BEM</td>
          <td class="dim">买入额的 0.70% + 货架 1% + 孤儿佣金 → 回购燃料</td></tr>
      ${m.admins.map((a) => `<tr>
        <td>${esc(a.symbol)} 项目方 <a href="${bscan(a.admin)}" target="_blank">${short(a.admin)}</a></td>
        <td class="num">${units(a.balance, QD, 4)} BEM</td>
        <td class="dim">二阶段货架铸币收入的 99%（EOA，平台不控制）</td></tr>`).join('')}
    </table>
    <p class="note">卖出税的 1% 是直接销毁代币，不进任何地址。LP 手续费留在池子里。</p>
  `)
}

function configPanel(c) {
  if (!c.ok) return panel('配置与漂移', '值是否还在该在的地方', unavailable(c))

  const ownerRow = (label, addr, isContract) => `<tr>
    <td>${esc(label)}</td>
    <td><a href="${bscan(addr)}" target="_blank">${short(addr)}</a></td>
    <td>${isContract ? flag('ok', '合约（Safe）') : flag('bad', 'EOA —— 单把私钥即可改协议')}</td></tr>`

  const dial = (label, v, max, d, unit) => {
    const used = Number(BigInt(v)) / Number(BigInt(max))
    return `<tr><td>${esc(label)}</td>
      <td class="num">${units(v, d, 4)} ${esc(unit)}</td>
      <td class="dim">上限 ${units(max, d, 2)}（${pct(used, 1)}）</td></tr>`
  }

  const trail = Object.entries(c.changes).filter(([, v]) => v.length > 0)

  return panel('配置与漂移', '值是否还在该在的地方', `
    <table>
      ${ownerRow('Factory owner', c.owner, c.ownerIsContract)}
      ${ownerRow('金库 owner', c.treasuryOwner, c.treasuryOwnerIsContract)}
      <tr><td>PoG 签名者</td><td><a href="${bscan(c.pogSigner)}" target="_blank">${short(c.pogSigner)}</a></td>
          <td>${c.signerIsContract ? flag('warn', '是合约 —— 签名者应为 EOA') : flag('ok', 'EOA（符合预期）')}</td></tr>
      <tr><td>暂停状态</td><td class="num">${c.paused ? '已暂停' : '运行中'}</td>
          <td>${c.paused ? flag('bad', '发射与注册都被挡住') : flag('ok', '正常')}</td></tr>
      <tr><td>阶梯熔断</td>
          <td class="num">${c.haltedUntil === 0 ? '未触发' : new Date(c.haltedUntil * 1000).toISOString().slice(0, 16)}</td>
          <td>${c.haltedUntil * 1000 > Date.now() ? flag('bad', '货架铸币被暂停') : flag('ok', '正常')}</td></tr>
      ${dial('launchFee', c.launchFee, c.maxLaunchFee, 18, 'BNB')}
      ${dial('defaultSoftCap', c.defaultSoftCap, c.maxSoftCap, 8, 'BEM')}
      ${dial('maxPogAllocationLimit', c.maxPogAlloc, c.maxPogLimit, 8, 'BEM')}
      <tr><td>发射冷却</td><td class="num">${c.cooldownHours} 小时</td><td class="dim"></td></tr>
      <tr><td>配额窗口</td><td class="num">${c.quotaWindowHours} 小时</td><td class="dim">配额是每窗口预算，不是终身</td></tr>
    </table>
    ${c.logsError
      ? `<div class="miss"><strong>变更记录不可用</strong>
          <div>上面的值是链上实时读数，准确；但拿不到事件历史，所以无法判断它们是否被改过。</div>
          <div class="dim">${esc(c.logsError)}</div></div>`
      : trail.length
        ? `<table><tr><th>配置变更记录</th><th>次数</th><th>最近</th></tr>
            ${trail.map(([name, v]) => `<tr><td>${esc(name)}</td><td class="num">${v.length}</td>
              <td><a href="${bscan(v[v.length - 1].tx, 'tx')}" target="_blank">#${v[v.length - 1].block}</a></td></tr>`).join('')}
          </table>`
        : '<p class="note">部署以来没有任何配置变更事件 —— 所有参数都还是部署时的值。</p>'}
  `)
}

function infraPanel(i) {
  if (!i.ok) return panel('基础设施预算', '两次线上事故的来源', unavailable(i))
  const lvl = i.daysLeft === null ? 'ok' : i.daysLeft < 3 ? 'bad' : i.daysLeft < 10 ? 'warn' : 'ok'
  return panel('基础设施预算', '两次线上事故的来源', `
    <table>
      <tr><td>Blockscout 额度余量</td>
          <td class="num">${i.credits === null ? '—' : i.credits.toLocaleString('en-US')}</td>
          <td class="dim">${i.credits === null ? '尚无读数（要等一次扫描写入）' : ''}</td></tr>
      <tr><td>观测到的扫描速率</td><td class="num">${i.scansPerHour.toFixed(1)} / 小时</td>
          <td class="dim">${i.scansObserved} 次，跨 ${i.windowsSeen} 个窗口；缓存命中不计入</td></tr>
      <tr><td>按此速率可撑</td>
          <td class="num ${lvl}">${i.daysLeft === null ? '—' : `${i.daysLeft.toFixed(1)} 天`}</td>
          <td>${i.daysLeft === null ? '<span class="dim">数据不足</span>'
            : lvl === 'bad' ? flag('bad', '不足三天 —— 需要处理')
            : lvl === 'warn' ? flag('warn', '十天以内')
            : flag('ok', '充裕')}
            <span class="dim">按每次扫描 25 次上游调用的悲观估计</span></td></tr>
      <tr><td>线上 PoG 门槛</td>
          <td class="num">${i.liveBand.floorWei ? units(i.liveBand.floorWei, 18, 4) : units(i.defaults.floorWei, 18, 4)} ETH</td>
          <td class="dim">${i.liveBand.floorWei ? 'Upstash 覆盖值' : '未覆盖，用代码默认值'}</td></tr>
      <tr><td>gas → 配额 倍率</td>
          <td class="num">${i.liveBand.rate ?? i.defaults.rate}</td>
          <td class="dim">${i.liveBand.rate ? 'Upstash 覆盖值' : '默认值'}</td></tr>
    </table>
  `)
}

export function render({ meta, funnel, pools, burn, money, config, infra }) {
  const QD = 8
  const TD = 18
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${meta.refreshSeconds}">
<title>Tosh 本地看板</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0a0c10; color:#c9d1d9; font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
         margin:0; padding:24px 28px 60px; }
  h1 { font-size:15px; letter-spacing:.14em; text-transform:uppercase; color:#e6edf3; margin:0 0 4px; }
  .meta { color:#6e7681; margin-bottom:26px; }
  .meta code { color:#8b949e; }
  section { border:1px solid #1f2630; border-radius:8px; padding:16px 18px; margin-bottom:18px; background:#0d1117; }
  h2 { font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:#e6edf3; margin:0 0 14px;
       border-bottom:1px solid #1f2630; padding-bottom:9px; }
  h2 .sub { float:right; text-transform:none; letter-spacing:0; color:#6e7681; font-weight:400; }
  h3 { font-size:13px; color:#e6edf3; margin:18px 0 8px; font-weight:600; }
  h3 a { margin-left:8px; font-weight:400; }
  table { border-collapse:collapse; width:100%; margin:10px 0; }
  th { text-align:left; color:#6e7681; font-weight:400; text-transform:uppercase; letter-spacing:.08em;
       font-size:11px; padding:5px 10px 5px 0; border-bottom:1px solid #1f2630; }
  td { padding:5px 10px 5px 0; border-bottom:1px solid #161b22; vertical-align:top; }
  td:first-child { color:#8b949e; width:210px; }
  .num { color:#e6edf3; font-variant-numeric:tabular-nums; white-space:nowrap; width:150px; }
  .dim { color:#6e7681; }
  a { color:#58a6ff; text-decoration:none; } a:hover { text-decoration:underline; }
  .steps { display:flex; align-items:center; gap:14px; margin:6px 0 18px; flex-wrap:wrap; }
  .step { flex:1; min-width:150px; border:1px solid #1f2630; border-radius:6px; padding:11px 13px; background:#0a0e14; }
  .step .k { color:#6e7681; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .step .v { font-size:26px; color:#e6edf3; line-height:1.25; font-variant-numeric:tabular-nums; }
  .arrow { color:#30363d; font-size:17px; }
  .bar { height:7px; background:#238636; border-radius:3px; min-width:2px; }
  .bar.warn { background:#9e6a03; } .bar.bad { background:#a4252c; }
  .ok { color:#3fb950; } .warn { color:#d29922; } .bad { color:#f85149; }
  .flag { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid currentColor; white-space:nowrap; }
  .flag.ok { color:#3fb950; } .flag.warn { color:#d29922; } .flag.bad { color:#f85149; }
  .miss { border:1px dashed #30363d; border-radius:6px; padding:13px; color:#8b949e; }
  .miss strong { color:#d29922; }
  .note { color:#8b949e; margin:10px 0 2px; }
  hr { border:0; border-top:1px solid #1f2630; margin:20px 0; }
  code { color:#79c0ff; }
</style>
<h1>Tosh 本地看板</h1>
<div class="meta">
  链 56 · 区块 <code>${meta.head}</code> · 起始 <code>${meta.fromBlock}</code>
  · RPC <code>${esc(meta.rpc)}</code>${meta.paidRpc ? ' (付费)' : ''}
  · 采集耗时 ${meta.elapsedMs} ms · ${esc(meta.generatedAt)}
  · 每 ${meta.refreshSeconds}s 自动刷新
</div>
${funnelPanel(funnel, QD)}
${poolPanel(pools, QD, TD)}
${burnPanel(burn, QD, TD)}
${moneyPanel(money, QD)}
${configPanel(config)}
${infraPanel(infra)}
`
}
