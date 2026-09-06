#!/usr/bin/env node
// 前端挂件冒烟测试：把注入到页面的 WIDGET_JS 真跑一遍（jsdom），验证
//   · Qwen 显示态渲染的是 Credits 而不是 ¥
//   · 超阈值 shouldAnnounce 自动冒泡，点击即确认
//   · 每轮消耗泡泡按套餐走 Credits 口径
//   · 菜单里「显示 / 套餐告警」两行确实存在并可改
// 没装 jsdom 时整份跳过（不误报失败）：node test/whale-widget-client.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let JSDOM
try {
  JSDOM = (await import('jsdom')).JSDOM
} catch (err) {
  console.log('跳过：本机没有 jsdom（pnpm add -D jsdom 后可跑）')
  process.exit(0)
}

const src = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
const bodyStart = src.indexOf('`', src.indexOf('const WIDGET_JS = `')) + 1
const client = src.slice(bodyStart, src.indexOf('})()`', bodyStart) + 4)

function qwenOk(over) {
  return Object.assign(
    {
      ok: true,
      estimated: true,
      source: 'ledger',
      provider: 'tokenplan',
      cap: 10000,
      used: 720,
      usedAllTime: 1500,
      remaining: 9280,
      pct: 7.2,
      dayIndex: 3,
      daysLeft: 5,
      windowIndex: 0,
      windowStart: 1,
      windowStartKey: '2026-09-03',
      windowEnd: 2,
      resetAt: Date.now() + 4.5 * 86400000,
      resetInMs: 4.5 * 86400000,
      anchorSource: 'config',
      today: { credits: 412.5, tokens: 1500000, calls: 88 },
      series: [{ credits: 0 }, { credits: 100 }, { credits: 200 }, { credits: 300 }, { credits: 400 }, { credits: 500 }, { credits: 412.5 }],
      windowDays: [],
      byModel: [{ model: 'qwen3.8-flash', credits: 700, tokens: 1, calls: 70 }],
      unknownModels: [],
      payg: { windowCny: 7.2, ledgerCny: 7.2, planPriceCny: 139, savedCny: -131.8, roiPercent: 5.2 },
      quotaHitAt: null,
      alert: { level: 'ok', label: '', pct: 7.2, warnPct: 70, shouldAnnounce: false },
      note: '',
      generatedAt: Date.now(),
    },
    over || {},
  )
}
// 72.5% ≥ 阈值：服务端那次现算会把 shouldAnnounce 置 true（同窗口同级只给一次）
const QWEN_WARN = qwenOk({
  used: 7250,
  remaining: 2750,
  pct: 72.5,
  byModel: [{ model: 'qwen3.8-flash', credits: 7250, tokens: 1, calls: 700 }],
  payg: { windowCny: 72.5, ledgerCny: 72.5, planPriceCny: 139, savedCny: -66.5, roiPercent: 52.2 },
  alert: { level: 'warn', label: '周额度告警', pct: 72.5, warnPct: 70, shouldAnnounce: true },
})
const BALANCE = { ok: true, totalBalance: 123.45, currency: 'CNY', todayUsage: 6.7, isPeak: false }

function makeWindow(opts) {
  const o = opts || {}
  const sizeCfg = Object.assign(
    {
      scale: 0.18,
      sound: false,
      vol: 0,
      soundSet: 'duck',
      usageMode: 'ledger',
      peakMode: 'default',
      bubbleOn: true,
      turnCostOn: true,
      turnCostCloseMs: 0,
      scrollGapOn: false,
      scrollGapPx: 0,
      display: 'qwen',
      qwenWarnPct: 70,
    },
    o.size || {},
  )
  let turnPolls = 0
  let qwenPolls = 0
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:3080/',
    // outside-only：页面不跑 script 标签，但 window.eval 能在窗口上下文里执行挂件脚本
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window
  // jsdom 没有 2D canvas：给 canvas/Image 打最小桩，让挂件的命中测试走完
  // （否则 isWhaleHit 永远返回 true，文档级拦截器会吃掉所有合成 click）。
  // 元素 getBoundingClientRect 宽度为 0 → isWhaleHit 走「不在鲸鱼上」分支。
  w.HTMLCanvasElement.prototype.getContext = function () {
    // 不透明像素：让 isWhaleHit 判定「按在鲸鱼身上」，走真正的拖拽/点击链
    return { drawImage: function () {}, getImageData: function () { return { data: [0, 0, 0, 255] } } }
  }
  w.Image = function () {
    var self = this
    var _src = ''
    Object.defineProperty(self, 'src', {
      get: function () { return _src },
      set: function (v) {
        _src = v
        setTimeout(function () { if (typeof self.onload === 'function') self.onload() }, 0)
      },
    })
  }
  const putCalls = []
  w.fetch = function (url, init) {
    const u = String(url)
    if (init && init.method === 'PUT') {
      putCalls.push({ url: u, body: JSON.parse(init.body) })
      return Promise.resolve({ json: function () { return Promise.resolve(sizeCfg) } })
    }
    let json
    if (u.indexOf('balance.json') !== -1) json = BALANCE
    else if (u.indexOf('qwen.json') !== -1) {
      qwenPolls++
      if (o.qwen === null) json = { ok: false, error: 'NO_DATA' }
      else {
        var base = o.qwen || QWEN_WARN
        // 服务端每次现算：同窗口同级只报一次，第 2 次起 shouldAnnounce=false
        json = qwenPolls === 1 ? base : qwenOk(Object.assign({}, base, { alert: Object.assign({}, base.alert, { shouldAnnounce: false }) }))
      }
    }
    else if (u.indexOf('size.json') !== -1) json = sizeCfg
    else if (u.indexOf('last-turn.json') !== -1) {
      // 默认给一个恒定 seq：前端只会「对齐」，不会弹消耗泡泡干扰别的用例
      turnPolls++
      json = o.turns && turnPolls > 1
        ? { ok: true, seq: 8, turn: 8, amount: null, credits: 42.5, provider: 'tokenplan', tokens: 1200, ts: Date.now() }
        : { ok: true, seq: 7, turn: 7, amount: null, credits: null, provider: '', tokens: 0, ts: Date.now() }
    } else json = { ok: false, error: 'unexpected ' + u }
    return Promise.resolve({ json: function () { return Promise.resolve(json) }, text: function () { return Promise.resolve('') } })
  }
  w.eval(client)
  // 鲸鱼命中测试要真跑：给 .dshwv-img 一个 610×610 的方框，于是
  //   框内坐标 → 命中（拖动/点鲸鱼）；框外坐标 → 穿透到 bubble 自己的 click
  var imgEl = w.document.querySelector('.dshwv-img')
  if (imgEl) {
    imgEl.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 610, height: 610, right: 610, bottom: 610, x: 0, y: 0 }
    }
  }
  return { dom, w, putCalls }
}
// 在鲸鱼轮廓外点一下（走 bubbleBox 自己的 click：确认/切台词）
function clickBubble(w) {
  el(w, '.dshwv-bubble').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 4000, clientY: 4000 }))
}
// 在鲸鱼身上按一下就松（走 pointerdown → endDrag → showBubble + refresh）
function clickWhale(w) {
  // pointerdown 必须落在鲸鱼 img 上（onDocPointerDown 会忽略 .dshwv-bubble 内的目标）
  var target = el(w, '.dshwv-img') || el(w, '.dshwv-root img')
  target.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0 }))
  w.document.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0 }))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const el = (w, sel) => w.document.querySelector(sel)
const txt = (w, sel) => (el(w, sel) ? el(w, sel).textContent : '(missing ' + sel + ')')

let passed = 0
function t(name, cond, extra) {
  if (cond) {
    passed++
    console.log('  ok   ' + name + (extra ? '  ' + extra : ''))
  } else {
    process.exitCode = 1
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''))
  }
}
function acctRow(w, key) {
  return w.document.querySelector('.dshwv-acct-item[data-acct="' + key + '"]')
}
function acctNums(w, key) {
  var r = acctRow(w, key)
  var n = r && r.querySelector('.dshwv-acct-nums')
  return n ? n.textContent : '(missing)'
}
function pickAcct(w, key) {
  // 菜单里的行点在鲸鱼轮廓外，走按钮自己的 click
  acctRow(w, key).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 4000, clientY: 4000 }))
}

console.log('\n[Qwen 显示态] 超阈值自动冒泡，点击确认后回到 Credits')
{
  const env = makeWindow({})
  await sleep(300)
  const w = env.w
  t('挂件已挂载', !!el(w, '.dshwv-root'))
  t('shouldAnnounce 自动冒泡', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') !== -1)
  t('告警标题「周额度告警」', txt(w, '.dshwv-label') === '周额度告警', JSON.stringify(txt(w, '.dshwv-label')))
  t('告警金额行为百分比', txt(w, '.dshwv-amount') === '72.5%', JSON.stringify(txt(w, '.dshwv-amount')))
  t('告警提示行给出已用/剩余', /7250\/10\.0k · 剩 2750/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('告警金额行变红', el(w, '.dshwv-amount').style.color === 'rgb(224, 67, 63)', el(w, '.dshwv-amount').style.color)
  clickBubble(w)
  await sleep(150)
  t('点击即确认关闭告警', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') === -1)
  // 关闭瞬间不闪现余额（沿用原挂件约定：文字等下次 showBubble 再恢复），
  // 但渲染锁必须解除 —— 切一次显示态就能看到常态画面
  pickAcct(w, 'ds')
  await sleep(120)
  t('锁解除后余额态能正常渲染', txt(w, '.dshwv-amount') === '¥ 123.45', JSON.stringify(txt(w, '.dshwv-amount')))
  pickAcct(w, 'qwen')
  await sleep(120)
  t('金额行 = 7250 Cr（不是 ¥）', txt(w, '.dshwv-amount') === '7250 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行含剩余与重置', /剩 2750/.test(txt(w, '.dshwv-hint')) && /重置/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('超阈值常态显示转橙色警示', el(w, '.dshwv-amount').style.color === 'rgb(224, 122, 31)', el(w, '.dshwv-amount').style.color)
  env.w.close()
}

console.log('\n[DeepSeek 显示态] 原行为不回归')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  t('金额行 = ¥ 余额', txt(w, '.dshwv-amount') === '¥ 123.45', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行 = 今日已用', /今日已用 ¥ 6\.70/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('未弹套餐告警', txt(w, '.dshwv-label') === 'DeepSeek 余额', JSON.stringify(txt(w, '.dshwv-label')))
  t('余额模式金额行无着色', el(w, '.dshwv-amount').style.color === '', JSON.stringify(el(w, '.dshwv-amount').style.color))
  env.w.close()
}

console.log('\n[菜单] 显示切换与阈值写回')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  t('列表两行账户（轮换已去掉）', !!acctRow(w, 'ds') && !!acctRow(w, 'qwen') && !acctRow(w, 'rotate'))
  t('默认选中 DeepSeek 行', acctRow(w, 'ds').className.indexOf('dshwv-acct-on') !== -1, acctRow(w, 'ds').className)
  t('DeepSeek 行 = 余额 + 今日', /¥ 123\.45/.test(acctNums(w, 'ds')) && /今 ¥ 6\.70/.test(acctNums(w, 'ds')), JSON.stringify(acctNums(w, 'ds')))
  t('Token Plan 行 = 已用/上限 + 累计', /720\/10\.0k/.test(acctNums(w, 'qwen')) && /累计 1500 Cr/.test(acctNums(w, 'qwen')), JSON.stringify(acctNums(w, 'qwen')))
  const warnInput = Array.prototype.slice.call(w.document.querySelectorAll('input[type=number]')).filter(function (i) { return i.value === '70' })[0]
  t('「套餐告警」阈值输入存在', !!warnInput)
  pickAcct(w, 'qwen')
  await sleep(120)
  t('点行后选中态转移', acctRow(w, 'qwen').className.indexOf('dshwv-acct-on') !== -1 && acctRow(w, 'ds').className.indexOf('dshwv-acct-on') === -1)
  t('切换后金额行变 Credits', txt(w, '.dshwv-amount') === '720 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  const put = env.putCalls[env.putCalls.length - 1]
  t('PUT 带 display=qwen', !!put && put.body.display === 'qwen', put ? JSON.stringify(put.body.display) : 'no PUT')
  warnInput.value = '55'
  warnInput.dispatchEvent(new w.Event('input'))
  await sleep(120)
  const put2 = env.putCalls[env.putCalls.length - 1]
  t('阈值改动写回 qwenWarnPct=55', !!put2 && put2.body.qwenWarnPct === 55, put2 ? String(put2.body.qwenWarnPct) : 'no PUT')
  env.w.close()
}

console.log('\n[点鲸鱼] Qwen 态先看套餐详情')
{
  const env = makeWindow({ size: { display: 'qwen' }, qwen: qwenOk() })
  await sleep(300)
  const w = env.w
  clickWhale(w)
  await sleep(400)
  t('点鲸鱼先开泡泡（显示常态读数）', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') !== -1)
  clickBubble(w)
  await sleep(700) // swapBubbleContent 有淡出→换字→淡入的节奏，给足时间
  t('标题行给出窗口第几天', /^第 \d\/7 天/.test(txt(w, '.dshwv-label')), JSON.stringify(txt(w, '.dshwv-label')))
  t('金额行是本周用量', txt(w, '.dshwv-amount') === '720 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行含今日与主力模型', /今日 413 ·/.test(txt(w, '.dshwv-hint')) && /qwen3\.8-flash/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[每轮消耗] 套餐轮次用 Credits')
{
  const env = makeWindow({ size: { display: 'ds' }, qwen: qwenOk(), turns: true })
  await sleep(2400) // pollLastTurn 每秒一次：首次对齐，第二次触发
  const w = env.w
  t('标题「上一轮套餐消耗:」', txt(w, '.dshwv-label') === '上一轮套餐消耗:', JSON.stringify(txt(w, '.dshwv-label')))
  t('金额行 ≈ 42.5 Cr', txt(w, '.dshwv-amount') === '≈ 42.5 Cr', JSON.stringify(txt(w, '.dshwv-amount')))
  t('提示行标注估算', /估算/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[自适应] 文字过长时不该把脚本搞崩（jsdom 宽度 0 → fit 早退）')
{
  const env = makeWindow({ size: { display: 'qwen' }, qwen: qwenOk({ used: 123456, cap: 10000, remaining: 0, pct: 1234.6, usedAllTime: 999999 }) })
  await sleep(3200)
  const w = env.w
  t('超长读数仍能渲染', txt(w, '.dshwv-amount').indexOf('123.5k') !== -1, JSON.stringify(txt(w, '.dshwv-amount')))
  t('超长时不抛异常（泡泡文字在）', txt(w, '.dshwv-hint').length > 0, JSON.stringify(txt(w, '.dshwv-hint')))
  env.w.close()
}

console.log('\n[无数据] 优雅显示')
{
  const env = makeWindow({ qwen: null })
  await sleep(300)
  const w = env.w
  t('空态金额行 --', txt(w, '.dshwv-amount') === '--', JSON.stringify(txt(w, '.dshwv-amount')))
  t('空态提示「暂无套餐用量记录」', /暂无套餐用量记录/.test(txt(w, '.dshwv-hint')), JSON.stringify(txt(w, '.dshwv-hint')))
  t('空态不冒泡', el(w, '.dshwv-bubble').className.indexOf('dshwv-bubble-open') === -1)
  env.w.close()
}

console.log('\n' + passed + ' 项通过')
