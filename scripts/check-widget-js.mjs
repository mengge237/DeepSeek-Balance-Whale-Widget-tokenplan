// 改 WIDGET_JS 之前先跑一下：node scripts/check-widget-js.mjs
//
// 为什么需要它。整个前端脚本是 lib/index.js 里的一个模板字面量：
//
//     const WIDGET_JS = `(function () { ... })()`
//
// 浏览器拿到的是这个模板**烤完的值**，反斜杠会先被吃掉一层。于是两类写法会出事：
//
//   1. 客户端里写字面 \n（单反斜杠）→ 烤完变成真换行塞进单引号字符串 →
//      整份 widget.js 成语法错误，挂件直接不出来，服务端一点日志都没有；
//   2. 客户端里写 \d 之类的正则转义 → 烤完反斜杠没了，`/^d{4}/` 照样能编译，
//      只是永远匹配不上 —— 比报错更难查。
//
// 而 `node --check`、直接 slice 原文做断言、以及"拿源码字符串测"的单测，
// 对这两类全是盲的：它们测的都是没烤过的原文，而浏览器跑的是烤完的那份。
//
// 这个脚本只做一件事：按浏览器的顺序把模板烤一遍，再编译一遍。零依赖。
//
// 正确写法：客户端里要换行用 String.fromCharCode(10)，要匹配数字用 [0-9] 字符类；
// 确实需要反斜杠时写双份（\\n），那才是给浏览器留下的那层。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'lib', 'index.js')
const BT = String.fromCharCode(96)
const BS = String.fromCharCode(92)

let failed = 0
function check(label, ok, extra) {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''))
  if (!ok) failed++
}

const src = fs.readFileSync(FILE, 'utf8')
const head = 'const WIDGET_JS = ' + BT
const start = src.indexOf(head)
if (start < 0) {
  console.log('FAIL 找不到 WIDGET_JS 模板（文件结构变了？改脚本里的 head 常量）')
  process.exit(1)
}
const bodyStart = start + head.length
// 模板的结束反引号在 IIFE 收尾的 })() 之后；这是本文件里唯一一个这样的位置
const end = src.lastIndexOf('})()' + BT)
const raw = src.slice(bodyStart, end + 4)
const firstLine = src.slice(0, bodyStart).split(String.fromCharCode(10)).length

console.log('\n[check-widget-js] ' + path.relative(ROOT, FILE).split(path.sep).join('/'))
check('取到 WIDGET_JS（' + raw.split(String.fromCharCode(10)).length + ' 行，起于源文件第 ' + firstLine + ' 行）', raw.length > 1000)

// 1) ${} 会真的插值进前端脚本，模板里只该有字面量
check('模板里没有 ${} 插值', raw.indexOf('${') < 0)

// 2) 反斜杠必须成对出现：模板吃掉一层，剩单份的就是写错了
const lone = []
const rawLines = raw.split(String.fromCharCode(10))
for (let i = 0; i < rawLines.length; i++) {
  const line = rawLines[i]
  for (let j = 0; j < line.length; j++) {
    if (line[j] !== BS) continue
    if (line[j + 1] === BS) { j++; continue }
    lone.push(firstLine + i + ':' + line.trim().slice(0, 60))
    break
  }
}
check('原文里反斜杠全部成对', lone.length === 0, lone.slice(0, 3).join(' | '))

// 3) 烤 + 4) 编译：这两步用的就是浏览器那份字节
let cooked = raw
try {
  cooked = eval(BT + raw + BT)
  check('模板能烤开', true)
} catch (err) {
  check('模板能烤开', false, String((err && err.message) || err).slice(0, 90))
}
try {
  new Function(cooked)
  check('烤完的脚本能编译（' + cooked.split(String.fromCharCode(10)).length + ' 行）', true)
} catch (err) {
  check('烤完的脚本能编译', false, String((err && err.message) || err).slice(0, 90))
}

// 5) 提前闭合 <script> 标签会让后面的内容变成 HTML
check('烤完的脚本里没有 </script>', cooked.indexOf('</script' + '>') < 0)

console.log(failed ? '\n' + failed + ' 项失败：客户端里的单反斜杠转义要改成双份，或换用无转义写法\n' : '\n全部通过\n')
process.exit(failed ? 1 : 0)
