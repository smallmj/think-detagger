// 单元测试：core.js 纯逻辑。不依赖 SillyTavern。
// 运行：node test/core.test.mjs
import assert from 'node:assert/strict';
import { detag, findThinkRegions, detagMes, detagReasoning, DEFAULT_TAGS } from '../core.js';

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
    try {
        assert.equal(actual, expected, label);
        passed++;
        console.log(`  PASS  ${label}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL  ${label}`);
        console.log(`        expected: ${JSON.stringify(expected)}`);
        console.log(`        actual:   ${JSON.stringify(actual)}`);
    }
}

const TAGS = ['now_plot', 'plot', 'StatusPlaceHolderImpl', '状态', 'UpdateVariable'];

console.log('\n== detag ==');
eq(detag('<now_plot>', TAGS), 'now_plot', '开标签去尖括号');
eq(detag('</now_plot>', TAGS), '/now_plot', '闭标签去尖括号保留斜杠');
eq(detag('<StatusPlaceHolderImpl/>', TAGS), 'StatusPlaceHolderImpl/', '自闭合去尖括号');
eq(detag('<now_plot attr="x">', TAGS), 'now_plot attr="x"', '带属性保留属性文字');
eq(detag('<b>bold</b>', TAGS), '<b>bold</b>', '白名单外 tag 不动');
eq(detag('<think>x</think>', TAGS), '<think>x</think>', '边界标签 think 不动');
eq(detag('<状态>', TAGS), '状态', '中文开标签');
eq(detag('</状态>', TAGS), '/状态', '中文闭标签');
eq(detag('<plotX>', TAGS), '<plotX>', '不误匹配前缀 tagX');
eq(detag('<plot>', TAGS), 'plot', 'plot 精确匹配');
eq(detag('文本 <now_plot>A</now_plot> 与 <plot>B</plot>', TAGS), '文本 now_plotA/now_plot 与 plotB/plot', '多 tag 混合');
// 幂等
const once = detag('<now_plot>A</now_plot>', TAGS);
eq(detag(once, TAGS), once, '幂等：再跑不变');
// 空与无 tag
eq(detag('', TAGS), '', '空串');
eq(detag('普通文本无标签', TAGS), '普通文本无标签', '无 tag 文本');

console.log('\n== findThinkRegions ==');
function contents(text) {
    return findThinkRegions(text).map(r => text.slice(r.contentStart, r.contentEnd));
}
function openFlags(text) {
    return findThinkRegions(text).map(r => r.openStart >= 0);
}
eq(findThinkRegions('').length, 0, '空串无 region');
eq(findThinkRegions('<think>无闭标签').length, 0, '无闭标签无 region');
eq(contents('<think>abc</think>')[0], 'abc', '标准配对 content');
eq(openFlags('<think>abc</think>')[0], true, '标准配对有开标签');
eq(contents('abc</think>')[0], 'abc', '仅收尾 content');
eq(openFlags('abc</think>')[0], false, '仅收尾无开标签');
// 多块：A</think> B <think>C</think> D
const multi = findThinkRegions('A部分</think> 中间 <think>C部分</think> 后');
eq(multi.length, 2, '多块两 region');
eq('A部分</think> 中间 <think>C部分</think> 后'.slice(multi[0].contentStart, multi[0].contentEnd), 'A部分', '多块 region0 content');
eq('A部分</think> 中间 <think>C部分</think> 后'.slice(multi[1].contentStart, multi[1].contentEnd), 'C部分', '多块 region1 content');
eq(openFlags('A部分</think> 中间 <think>C部分</think> 后')[0], false, '多块 region0 仅收尾');
eq(openFlags('A部分</think> 中间 <think>C部分</think> 后')[1], true, '多块 region1 标准配对');
// thinking 标签
eq(contents('<thinking>xyz</thinking>')[0], 'xyz', 'thinking 标签识别');
eq(contents('xyz</thinking>')[0], 'xyz', 'thinking 仅收尾');
// 大小写
eq(contents('<THINK>up</THINK>')[0], 'up', '大小写不敏感');

console.log('\n== detagMes ==');
eq(detagMes('<think>推演 <now_plot>教堂</now_plot></think>正文', TAGS).mes,
   '<think>推演 now_plot教堂/now_plot</think>正文', '标准配对：内部去 tag 边界保留');
eq(detagMes('推演 <now_plot>教堂</now_plot></think>正文', TAGS).mes,
   '推演 now_plot教堂/now_plot</think>正文', '仅收尾：内部去 tag 闭标签保留');
eq(detagMes('思A <now_plot>X</now_plot></think> 正文1 <think>思B <plot>Y</plot></think> 正文2', TAGS).mes,
   '思A now_plotX/now_plot</think> 正文1 <think>思B plotY/plot</think> 正文2', '多块混合各自处理');
eq(detagMes('<think>推演 <now_plot>教堂</now_plot>', TAGS).changed, false, '无闭标签不处理');
eq(detagMes('正文 <b>粗体</b> 无 think', TAGS).changed, false, '无 think 块不处理');
eq(detagMes('正文 <b>粗体</b> 无 think', TAGS).mes, '正文 <b>粗体</b> 无 think', '正文 HTML 不动');
// 含 _.set 不受影响（MVU 命令非白名单 tag）
eq(detagMes('<think>_.set(\'a\',1,2)//原因 <now_plot>X</now_plot></think>', TAGS).mes,
   '<think>_.set(\'a\',1,2)//原因 now_plotX/now_plot</think>', '_.set 命令保留');

console.log('\n== detagReasoning ==');
eq(detagReasoning('推演 <now_plot>X</now_plot>', TAGS).reasoning,
   '推演 now_plotX/now_plot', 'reasoning 整段 detag');
eq(detagReasoning('', TAGS).changed, false, 'reasoning 空不变');
eq(detagReasoning(null, TAGS).changed, false, 'reasoning null 不变');

console.log(`\n== 结果: ${passed} passed, ${failed} failed ==`);
if (failed > 0) process.exit(1);
