// 单元测试：core.js 纯逻辑。不依赖 SillyTavern。
// 运行：node test/core.test.mjs
import assert from 'node:assert/strict';
import { detag, findThinkRegions, detagMes, detagReasoning, findUnknownTags, DEFAULT_TAGS } from '../core.js';

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
eq(detag('<now_plot>', TAGS).text, 'now_plot', '开标签去尖括号');
eq(detag('</now_plot>', TAGS).text, '/now_plot', '闭标签去尖括号保留斜杠');
eq(detag('<StatusPlaceHolderImpl/>', TAGS).text, 'StatusPlaceHolderImpl/', '自闭合去尖括号');
eq(detag('<now_plot attr="x">', TAGS).text, 'now_plot attr="x"', '带属性保留属性文字');
eq(detag('<b>bold</b>', TAGS).text, '<b>bold</b>', '白名单外 tag 不动');
eq(detag('<think>x</think>', TAGS).text, '<think>x</think>', '边界标签 think 不动');
eq(detag('<状态>', TAGS).text, '状态', '中文开标签');
eq(detag('</状态>', TAGS).text, '/状态', '中文闭标签');
eq(detag('<plotX>', TAGS).text, '<plotX>', '不误匹配前缀 tagX');
eq(detag('<plot>', TAGS).text, 'plot', 'plot 精确匹配');
eq(detag('文本 <now_plot>A</now_plot> 与 <plot>B</plot>', TAGS).text, '文本 now_plotA/now_plot 与 plotB/plot', '多 tag 混合');
// removedTags 记录
{
    const r = detag('<now_plot>A</now_plot> <plot>B</plot> 无tag', TAGS);
    eq([...r.removedTags].sort().join(','), 'now_plot,plot', 'removedTags 记录被去 tag');
    eq(r.text, 'now_plotA/now_plot plotB/plot 无tag', 'removedTags 同时正确替换');
}
eq(detag('无 tag 文本', TAGS).removedTags.size, 0, '无 tag 时 removedTags 为空');
// 幂等
const once = detag('<now_plot>A</now_plot>', TAGS).text;
eq(detag(once, TAGS).text, once, '幂等：再跑不变');
eq(detag(once, TAGS).removedTags.size, 0, '幂等：removedTags 为空');
// 空与无 tag
eq(detag('', TAGS).text, '', '空串');
eq(detag('普通文本无标签', TAGS).text, '普通文本无标签', '无 tag 文本');

console.log('\n== findThinkRegions ==');
function contents(text, tags) {
    return findThinkRegions(text, tags).map(r => text.slice(r.contentStart, r.contentEnd));
}
function openFlags(text, tags) {
    return findThinkRegions(text, tags).map(r => r.openStart >= 0);
}
eq(findThinkRegions('').length, 0, '空串无 region');
eq(findThinkRegions('<think>无闭标签').length, 0, '无闭标签无 region');
eq(contents('<think>abc</think>')[0], 'abc', '标准配对 content');
eq(openFlags('<think>abc</think>')[0], true, '标准配对有开标签');
eq(contents('abc</think>')[0], 'abc', '仅收尾 content');
eq(openFlags('abc</think>')[0], false, '仅收尾无开标签');
const multi = findThinkRegions('A部分</think> 中间 <think>C部分</think> 后');
eq(multi.length, 2, '多块两 region');
eq('A部分</think> 中间 <think>C部分</think> 后'.slice(multi[0].contentStart, multi[0].contentEnd), 'A部分', '多块 region0 content');
eq('A部分</think> 中间 <think>C部分</think> 后'.slice(multi[1].contentStart, multi[1].contentEnd), 'C部分', '多块 region1 content');
eq(openFlags('A部分</think> 中间 <think>C部分</think> 后')[0], false, '多块 region0 仅收尾');
eq(openFlags('A部分</think> 中间 <think>C部分</think> 后')[1], true, '多块 region1 标准配对');
eq(contents('<thinking>xyz</thinking>')[0], 'xyz', 'thinking 标签识别');
eq(contents('xyz</thinking>')[0], 'xyz', 'thinking 仅收尾');
eq(contents('<THINK>up</THINK>')[0], 'up', '大小写不敏感');
eq(contents('<think attr="x">abc</think>')[0], 'abc', '带属性 think 开标签');
eq(contents('abc</think >')[0], 'abc', '带空白 think 闭标签');
eq(contents('abc</thinking\t>')[0], 'abc', '带制表符 thinking 闭标签');

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
eq(detagMes('<think>_.set(\'a\',1,2)//原因 <now_plot>X</now_plot></think>', TAGS).mes,
   '<think>_.set(\'a\',1,2)//原因 now_plotX/now_plot</think>', '_.set 命令保留');
// detagMes removedTags 聚合
{
    const rm = detagMes('<think>a <now_plot>x</now_plot> <plot>y</plot></think>', TAGS);
    eq([...rm.removedTags].sort().join(','), 'now_plot,plot', 'detagMes removedTags 聚合');
}

console.log('\n== detagReasoning ==');
eq(detagReasoning('推演 <now_plot>X</now_plot>', TAGS).reasoning,
   '推演 now_plotX/now_plot', 'reasoning 整段 detag');
eq(detagReasoning('', TAGS).changed, false, 'reasoning 空不变');
eq(detagReasoning(null, TAGS).changed, false, 'reasoning null 不变');
{
    const rr = detagReasoning('a <now_plot>x</now_plot> <plot>y</plot>', TAGS);
    eq([...rr.removedTags].sort().join(','), 'now_plot,plot', 'reasoning removedTags');
}

console.log('\n== 自定义思考标签 ==');
const CT = ['reason', 'cot'];
eq(contents('<reason>abc</reason>', CT)[0], 'abc', '自定义标签 reason 标准配对');
eq(contents('abc</reason>', CT)[0], 'abc', '自定义标签 reason 仅收尾');
eq(openFlags('abc</reason>', CT)[0], false, '自定义标签仅收尾无开标签');
eq(contents('<cot>xyz</cot>', CT)[0], 'xyz', '自定义标签 cot');
eq(contents('<think>old</think>', CT).length, 0, 'think 不在自定义标签时不识别');
eq(detagMes('<reason>推演 <now_plot>X</now_plot></reason>正文', TAGS, CT).mes,
   '<reason>推演 now_plotX/now_plot</reason>正文', '自定义标签内部去 tag 边界保留');
eq(detagMes('推演 <now_plot>X</now_plot></reason>正文', TAGS, CT).mes,
   '推演 now_plotX/now_plot</reason>正文', '自定义标签仅收尾内部去 tag');
eq(detagMes('<think>a <now_plot>b</now_plot></think>', TAGS).mes,
   '<think>a now_plotb/now_plot</think>', '不传 thinkTags 用默认 think/thinking');

console.log('\n== findUnknownTags ==');
{
    // 处理后残留未知 tag
    const after = detagMes('<think>a <now_plot>x</now_plot> <weird_tag>y</weird_tag></think>', ['now_plot']).mes;
    eq(findUnknownTags(after, ['think'], ['now_plot'], ['b']).join(), 'weird_tag', '扫描残留未知 tag');
}
{
    // 安全 HTML 排除
    const after2 = detagMes('<think>a <now_plot>x</now_plot> <b>y</b></think>', ['now_plot']).mes;
    eq(findUnknownTags(after2, ['think'], ['now_plot'], ['b']).length, 0, '安全 HTML 不报');
}
{
    // 已处理 tag 不报
    eq(findUnknownTags('<think>a <now_plot>x</now_plot></think>', ['think'], ['now_plot'], []).length, 0, '已处理 tag 不报');
}
{
    // 无 think 区段不扫
    eq(findUnknownTags('无 think 块 <weird>x</weird>', ['think'], [], []).length, 0, '无 think 区段不扫');
}
{
    // 多个未知 tag
    const after3 = detagMes('<think><now_plot>x</now_plot> <foo>1</foo> <bar>2</bar></think>', ['now_plot']).mes;
    eq(findUnknownTags(after3, ['think'], ['now_plot'], []).sort().join(','), 'bar,foo', '多个未知 tag 全部发现');
}

console.log(`\n== 结果: ${passed} passed, ${failed} failed ==`);
if (failed > 0) process.exit(1);
