/**
 * HTML for the dashboard.
 *
 * Server-rendered on each request with no client-side JavaScript beyond a meta
 * refresh. Everything on the page is read on this machine, so there is nothing
 * to gain from shipping a client that could fetch it again.
 */

import { ethers } from 'ethers'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
))

const units = (v, d = 18, places = 4) => Number(ethers.formatUnits(BigInt(v ?? 0), d))
  .toLocaleString('en-US', { maximumFractionDigits: places })

const pct = (f, places = 2) => (f === null || f === undefined ? '—' : `${(f * 100).toFixed(places)}%`)
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`
const bscan = (a, kind = 'address') => `https://bscscan.com/${kind}/${a}`
const link = (a, kind) => `<a href="${bscan(a, kind)}" target="_blank">${short(a)}</a>`

/** Seconds as the largest one or two units, for countdowns and ages. */
function span(seconds) {
  const s = Math.abs(seconds)
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 172800) return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d${Math.round((s % 86400) / 3600)}h`
}

/** A panel that could not be filled says so, rather than showing zero. */
const unavailable = (p) => `<div class="miss"><strong>无法采集</strong><div class="dim">${esc(p.error || '')}</div></div>`

const panel = (title, subtitle, body) => `<section>
  <h2>${esc(title)}<span class="sub">${esc(subtitle)}</span></h2>
  ${body}
</section>`

/** Only three states, so the page cannot become all-warning. */
const flag = (level, text) => `<span class="flag ${level}">${esc(text)}</span>`

function platformPanel(p, now) {
  if (!p.ok) return panel('平台与权限', '所有权链、开关、托管', unavailable(p))

  const failed = p.checks.filter((x) => !x.ok)
  const checks = `<table>
    ${p.checks.map((x) => `<tr><td>${x.ok ? flag('ok', '通过') : flag('bad', '不符')}</td><td colspan="2">${esc(x.text)}</td></tr>`).join('')}
  </table>`

  const markets = p.markets.map((m) => {
    const halted = m.ladderHaltedUntil > now
    const switches = [
      m.paused ? flag('bad', '工厂已暂停（不能上新项目）') : flag('ok', '工厂运行中'),
      m.genesisPaused ? flag('bad', '全局暂停发售') : flag('ok', '发售开放'),
      halted ? flag('warn', `货架铸造暂停 ${span(m.ladderHaltedUntil - now)}`) : flag('ok', '货架铸造开放'),
    ].join(' ')
    return `
      <h3>${esc(m.symbol)} 市场 ${link(m.factory)}</h3>
      <div class="flags">${switches}</div>
      <table>
        <tr><td>项目数</td><td class="num">${m.launchCount}</td><td></td></tr>
        <tr><td>最低单笔</td><td class="num">${units(m.minBuy, m.quoteDecimals)} ${esc(m.symbol)}</td><td class="dim">合约常量，不可改</td></tr>
        <tr><td>硬顶范围</td><td class="num">${units(m.minHardCap, m.quoteDecimals)} – ${units(m.maxHardCap, m.quoteDecimals)}</td><td class="dim">Safe 可通过 gateway.execute 调整</td></tr>
        <tr><td>单 Agent 上限范围</td><td class="num">${units(m.minAgentCap, m.quoteDecimals)} – ${units(m.maxAgentCap, m.quoteDecimals)}</td><td class="dim">同上</td></tr>
        <tr><td>回购储备</td><td class="num">${units(m.reservoir, m.quoteDecimals)} ${esc(m.symbol)}</td>
            <td class="dim">下一次花 ${units(m.nextSpend, m.quoteDecimals)}，距下次触发还差 ${units(m.untilTrigger, m.quoteDecimals)} · 货架代币 ${m.ladderTokens} 个${m.piggyback ? ' · 回购执行中' : ''}</td></tr>
        <tr><td>BidBook 托管</td><td class="num">${units(m.escrow, m.quoteDecimals)} ${esc(m.symbol)}</td>
            <td class="dim">未提手续费 ${units(m.fees, m.quoteDecimals)} · 合约余额 ${units(m.bookBalance, m.quoteDecimals)} ${m.bookSolvent ? flag('ok', '足额') : flag('bad', '不足')}</td></tr>
      </table>`
  }).join('<hr>')

  const owners = p.safe.owners.map((o) => link(o)).join(' ')
  return panel('平台与权限', failed.length ? `${failed.length} 项不符` : '全部符合部署设计', `
    ${checks}
    <table>
      <tr><td>所有者 Safe</td><td class="num">${link(p.safe.address)}</td><td class="dim">${p.safe.threshold}-of-${p.safe.owners.length}：${owners}</td></tr>
      <tr><td>BidBook</td><td class="num">${link(p.bidBook.address)}</td><td class="dim">累计挂单 ${p.bidBook.nextBidId - 1} · 手续费收款 ${link(p.bidBook.feeRecipient)}</td></tr>
    </table>
    ${p.deploymentFile ? '' : '<p class="note">本机没有 deployments/v2-56.json，未与部署记录比对地址。</p>'}
    <hr>${markets}
  `)
}

function launchesPanel(l, now) {
  if (!l.ok) return panel('项目', '发售与上线', unavailable(l))
  if (!l.launches.length) return panel('项目', '发售与上线', '<div class="miss">两个工厂都还没有项目。</div>')

  const rows = l.launches.map((x) => {
    const d = x.quoteDecimals
    const fill = x.hardCap > 0n ? Number((x.raised * 10000n) / x.hardCap) / 10000 : 0
    let timing = ''
    if (x.phase.key === 'genesis') timing = `剩 ${span(x.genesisDeadline - now)}`
    else if (x.phase.key === 'soldOut' || x.phase.key === 'ended') {
      timing = now < x.publicLaunchAt ? `Circuit 持有人独占上线，剩 ${span(x.publicLaunchAt - now)}` : '任何人可上线'
    }
    const extra = [x.hookPaused && flag('bad', '本项目暂停发售'), x.ladderHalted && flag('warn', '货架暂停')].filter(Boolean).join(' ')
    return `<tr>
      <td><strong>${esc(x.symbol)}</strong> <span class="dim">${esc(x.name)}</span><br>${link(x.hook)} · ${esc(x.symbolQ)}</td>
      <td>${flag(x.phase.level, x.phase.text)} ${extra}<div class="dim">${esc(timing)}</div></td>
      <td class="num">${units(x.raised, d)} / ${units(x.hardCap, d)}<div class="bar" style="width:${Math.max(1, Math.round(fill * 100))}%"></div></td>
      <td class="num">${pct(fill, 1)}</td>
      <td class="num">${units(x.currentPrice, d, 10)}</td>
      <td class="dim">单 Agent ≤ ${units(x.perAgentCap, d)} · 资金 ${units(x.fundAvailable, d)} 可提<br>控制人 ${link(x.controller)}</td>
    </tr>`
  }).join('')

  const pools = l.launches.filter((x) => x.pool).map((x) => {
    const p = x.pool
    if (!p.ok) return `<h3>${esc(x.symbol)}</h3>${unavailable(p)}`
    const q = esc(x.symbolQ)
    return `
      <h3>${esc(x.symbol)} 池子 <a href="${bscan(x.token, 'token')}" target="_blank">${short(x.token)}</a></h3>
      <table>
        <tr><td>现价</td><td class="num">${p.spot.toPrecision(6)}</td><td class="dim">${q} / ${esc(x.symbol)}</td></tr>
        <tr><td>池内深度</td><td class="num">${p.depthQuote.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${q}</td>
            <td class="dim">配 ${p.depthToken.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${esc(x.symbol)}</td></tr>
        <tr><td>池子费</td><td class="num">${(p.swapFeePips / 10000).toFixed(4)}%</td><td class="dim">另有 1% hook 税从输入扣除</td></tr>
        <tr><td>${p.probe} ${q} 来回成本</td><td class="num">${pct(p.roundTrip, 3)}</td><td class="dim">两次 1% 税 + 两次池子费 + 冲击</td></tr>
        <tr><td>货架</td><td class="num">第 ${p.tier.index} 层</td>
            <td class="dim">${p.tier.unlocked ? flag('ok', '可铸造') : flag('warn', '货架价高于防插针参考价，暂不可铸造')} · 本层剩 ${units(p.tier.remaining, 18, 0)}</td></tr>
      </table>
      <table>
        <tr><th>买入规模</th><th>价格冲击</th><th></th></tr>
        ${p.curve.map((cv) => {
          const lvl = cv.impact > 0.05 ? 'bad' : cv.impact > 0.01 ? 'warn' : 'ok'
          return `<tr><td>${cv.quote} ${q}</td><td class="num ${lvl}">${pct(cv.impact, 2)}</td>
            <td><div class="bar ${lvl}" style="width:${Math.min(100, Math.round(cv.impact * 1000))}%"></div></td></tr>`
        }).join('')}
      </table>`
  }).join('<hr>')

  return panel('项目', `${l.launches.length} 个`, `
    <table>
      <tr><th>项目</th><th>阶段</th><th>已募 / 硬顶</th><th>进度</th><th>当前发售价</th><th></th></tr>
      ${rows}
    </table>
    ${pools ? `<hr>${pools}` : ''}
  `)
}

function activityPanel(a) {
  if (!a.ok) return panel('链上活动', '部署以来的事件', unavailable(a))

  const cols = a.markets.map((m) => {
    const d = m.quoteDecimals
    const s = esc(m.symbol)
    return `<td>
      <table>
        <tr><td>发售买入</td><td class="num">${m.buys} 笔 · ${units(m.paid, d)} ${s}</td></tr>
        <tr><td>买家</td><td class="num">${m.agents} 个 Agent · ${m.wallets} 个钱包</td></tr>
        <tr><td>上线</td><td class="num">${m.launches}</td></tr>
        <tr><td>BidBook</td><td class="num">挂 ${m.bidsPlaced} · 成交 ${m.bidsFilled} · 撤 ${m.bidsCancelled}</td></tr>
        <tr><td>BidBook 成交额</td><td class="num">${units(m.filledGross, d)} ${s} · 费 ${units(m.bookFees, d)}</td></tr>
        <tr><td>货架铸造</td><td class="num">${m.shelfMints} 次 · ${units(m.shelfSpent, d)} ${s}</td></tr>
        <tr><td>税收进储备</td><td class="num">${units(m.taxIn, d)} ${s}</td></tr>
        <tr><td>回购销毁</td><td class="num">${m.buybacks} 次 · 花 ${units(m.buybackSpent, d)} ${s} · 烧 ${units(m.buybackBurned, 18, 0)}</td></tr>
        <tr><td>卖出税销毁</td><td class="num">${units(m.sellTaxBurned, 18, 0)}</td></tr>
        <tr><td>回购跳过</td><td class="num">${m.skipped ? flag(m.skipped > m.buybacks ? 'bad' : 'warn', `${m.skipped} 次`) : flag('ok', '0')}</td></tr>
        <tr><td>回购调用失败</td><td class="num">${m.pokeFailures ? flag('warn', `${m.pokeFailures} 次`) : flag('ok', '0')}</td></tr>
      </table>
    </td>`
  }).join('')

  const buys = a.recentBuys.length
    ? `<table><tr><th>区块</th><th>市场</th><th>项目</th><th>买家</th><th>支付</th><th>得到</th></tr>
        ${a.recentBuys.map((b) => `<tr><td><a href="${bscan(b.tx, 'tx')}" target="_blank">${b.block}</a></td>
          <td>${esc(b.market.toUpperCase())}</td><td>${link(b.hook)}</td><td>${link(b.buyer)}</td>
          <td class="num">${units(b.paid)}</td><td class="num">${units(b.tokens, 18, 0)}</td></tr>`).join('')}
      </table>`
    : '<p class="note">还没有发售买入。</p>'

  return panel('链上活动', `缓存 ${a.logCount} 条事件，同步到 ${a.syncedTo}`, `
    <table class="split"><tr>${a.markets.map((m) => `<th>${esc(m.symbol)} 市场</th>`).join('')}</tr><tr>${cols}</tr></table>
    <h3>最近的发售买入</h3>
    ${buys}
  `)
}

function adminPanel(a) {
  if (!a.ok) return panel('管理操作', '所有者一侧的事件', unavailable(a))
  const body = a.admin.length
    ? `<table><tr><th>区块</th><th>市场</th><th>事件</th><th>合约</th><th>参数</th></tr>
        ${a.admin.map((x) => `<tr><td><a href="${bscan(x.tx, 'tx')}" target="_blank">${x.block}</a></td>
          <td>${esc((x.market || '').toUpperCase())}</td><td>${esc(x.name)}</td><td>${link(x.address)}</td>
          <td class="dim">${esc(x.args)}</td></tr>`).join('')}
      </table>`
    : '<p class="note">部署以来没有管理操作。</p>'
  return panel('管理操作', '暂停、拉黑、调参、所有权：没人通知过的变化会出现在这里', body)
}

function infraPanel(i) {
  if (!i.ok) return panel('读取', 'RPC', unavailable(i))
  const lag = i.headAgeSeconds
  return panel('读取', '数据从哪里来', `
    <table>
      <tr><td>当前 RPC</td><td class="num">${esc(i.rpc)}</td><td class="dim">${i.paid ? '来自 BSC_RPC' : '内置公共节点'}</td></tr>
      <tr><td>最新区块</td><td class="num">${i.head}</td>
          <td>${lag > 60 ? flag('bad', `落后 ${span(lag)}`) : flag('ok', `${lag}s 前出块`)}</td></tr>
      <tr><td>候选节点</td><td colspan="2" class="dim">${i.endpoints.map(esc).join(' · ')}</td></tr>
    </table>
  `)
}

export function render({ meta, platform, launches, activity, infra }) {
  const now = meta.headTs
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${meta.refreshSeconds}">
<title>ToshX v2 本地看板</title>
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
  table.split > tbody > tr > td { width:50%; border:0; padding-right:24px; color:inherit; }
  .num { color:#e6edf3; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .dim { color:#6e7681; }
  a { color:#58a6ff; text-decoration:none; } a:hover { text-decoration:underline; }
  .flags { margin:4px 0 8px; display:flex; gap:8px; flex-wrap:wrap; }
  .bar { height:7px; background:#238636; border-radius:3px; min-width:2px; margin-top:4px; }
  .bar.warn { background:#9e6a03; } .bar.bad { background:#a4252c; }
  .ok { color:#3fb950; } .warn { color:#d29922; } .bad { color:#f85149; }
  .flag { font-size:11px; padding:1px 7px; border-radius:10px; border:1px solid currentColor; white-space:nowrap; }
  .flag.ok { color:#3fb950; } .flag.warn { color:#d29922; } .flag.bad { color:#f85149; } .flag.dim { color:#6e7681; }
  .miss { border:1px dashed #30363d; border-radius:6px; padding:13px; color:#8b949e; }
  .miss strong { color:#d29922; }
  .note { color:#8b949e; margin:10px 0 2px; }
  hr { border:0; border-top:1px solid #1f2630; margin:20px 0; }
  code { color:#79c0ff; }
</style>
<h1>ToshX v2 本地看板</h1>
<div class="meta">
  链 56 · 区块 <code>${meta.head}</code> · RPC <code>${esc(meta.rpc)}</code>${meta.paidRpc ? '（BSC_RPC）' : ''}
  · 采集耗时 ${meta.elapsedMs} ms · ${esc(meta.generatedAt)}
  · 每 ${meta.refreshSeconds}s 自动刷新 · <a href="/refresh">立即刷新</a>
</div>
${platformPanel(platform, now)}
${launchesPanel(launches, now)}
${activityPanel(activity)}
${adminPanel(activity)}
${infraPanel(infra)}
`
}
