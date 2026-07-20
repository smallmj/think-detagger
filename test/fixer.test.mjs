// 单元测试：fixer.js 纯逻辑。不依赖 SillyTavern。
// 运行：node test/fixer.test.mjs
import assert from 'node:assert/strict';
import {
    stripNonNarrative,
    contentFingerprint,
    detectIssues,
    extractFormatRequirements,
    buildFixPrompt,
} from '../fixer.js';

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
function ok(cond, label) {
    if (cond) { passed++; console.log(`  PASS  ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}`); }
}

// 模拟 examples 测试文本结构（仅收尾 think + 空 now_plot + 正文在外 + 变量块 + 生图）
const SAMPLE = `思考内容这里 <interactive_input>合理</interactive_input>
</think>
<now_plot>

</now_plot>
<action_option>[Opt1:😇] 选项</action_option>
<update><json_patch>{ "op": "replace", "path": "/x", "value": "y" }</json_patch></update>
<summary>摘要文字</summary>
正文叙事何协看着下面的放映厅。
{何协}「不用急着加料。」
<DiceCheck>
角色: 史蒂芬妮
检定: 感知
特图的旁白: [点评]
</DiceCheck>
<image>image###prompt###</image>
<pic>SFW/爱弥斯/得意3</pic>
<UpdateVariable><update_analysis>分析</update_analysis><json_patch>[{ "op": "replace", "path": "/a", "value": 1 }]</json_patch></UpdateVariable>`;

console.log('\n== stripNonNarrative ==');
const stripped = stripNonNarrative(SAMPLE);
ok(!stripped.includes('json_patch'), '剥离 json_patch 块');
ok(!stripped.includes('update_analysis'), '剥离 update_analysis 块');
ok(!stripped.includes('image###'), '剥离 image 生图 tag');
ok(!stripped.includes('SFW/爱弥斯'), '剥离 pic 生图 tag');
ok(stripped.includes('正文叙事何协'), '保留正文叙事');
ok(stripped.includes('DiceCheck'), '保留 Optional 模组');
ok(stripped.includes('思考内容这里'), '保留思考内容（不剥离）');

console.log('\n== contentFingerprint ==');
// 变量块内部改 -> 指纹不变
const sampleVarChanged = SAMPLE.replace('"value": "y"', '"value": "z"');
eq(contentFingerprint(SAMPLE), contentFingerprint(sampleVarChanged), '变量块 value 改动指纹不变');
// 生图 prompt 改 -> 指纹不变（生图剥离）
const sampleImgChanged = SAMPLE.replace('image###prompt###', 'image###other###');
eq(contentFingerprint(SAMPLE), contentFingerprint(sampleImgChanged), '生图 prompt 改动指纹不变');
// 正文润色 -> 指纹变
const sampleNarrativeChanged = SAMPLE.replace('何协看着下面', '何协注视着下面');
ok(contentFingerprint(SAMPLE) !== contentFingerprint(sampleNarrativeChanged), '正文润色指纹变');
// 思考内容改 -> 指纹变（思考不剥离，防 LLM 改思考）
const sampleThinkChanged = SAMPLE.replace('思考内容这里', '思考内容那里');
ok(contentFingerprint(SAMPLE) !== contentFingerprint(sampleThinkChanged), '思考内容改动指纹变');
// 幂等
eq(contentFingerprint(SAMPLE), contentFingerprint(SAMPLE), '指纹幂等');

console.log('\n== detectIssues ==');
const d1 = detectIssues(SAMPLE);
ok(d1.hasIssues, 'SAMPLE 检出问题');
ok(d1.issues.some(s => s.includes('now_plot 为空')), '检出 now_plot 为空');
ok(d1.issues.some(s => s.includes('正文在 now_plot 外')), '检出正文在 now_plot 外');
// json_patch 语法错
const sampleJsonBad = SAMPLE.replace('"op": "replace", "path": "/x", "value": "y"', '"op": replace path /x value y');
const d2 = detectIssues(sampleJsonBad);
ok(d2.issues.some(s => s.includes('json_patch 语法错误')), '检出 json_patch 语法错误');
// 代码块未配对
const sampleCodeBad = SAMPLE + '\n```code\n未闭合';
const d3 = detectIssues(sampleCodeBad);
ok(d3.issues.some(s => s.includes('代码块未配对')), '检出代码块未配对');
// 无问题：正文在 now_plot 内，json 正确
const CLEAN = `<think>思考</think>
<now_plot>正文叙事何协看着下面。{何协}「对白」</now_plot>
<UpdateVariable><json_patch>[{ "op": "replace", "path": "/a", "value": 1 }]</json_patch></UpdateVariable>`;
const d4 = detectIssues(CLEAN);
ok(!d4.issues.some(s => s.includes('now_plot 为空') || s.includes('正文在 now_plot 外')), 'CLEAN 无 now_plot/正文位置问题');
ok(!d4.issues.some(s => s.includes('json_patch 语法错误')), 'CLEAN 无 json 语法问题');

console.log('\n== extractFormatRequirements ==');
const fr1 = extractFormatRequirements({
    wiContents: ['世界书条目A', '世界书条目B'],
    promptContents: ['预设prompt1'],
    manualText: '手动要求',
    useWorldInfo: true, usePreset: true, useManual: true,
});
ok(fr1.includes('世界书格式要求') && fr1.includes('世界书条目A'), '含世界书来源');
ok(fr1.includes('预设格式要求') && fr1.includes('预设prompt1'), '含预设来源');
ok(fr1.includes('手动格式要求') && fr1.includes('手动要求'), '含手动来源');
// 只开手动
const fr2 = extractFormatRequirements({ manualText: '只要手动', useManual: true });
ok(fr2 === '【手动格式要求】\n只要手动', '仅手动来源');
// 全关
const fr3 = extractFormatRequirements({});
eq(fr3, '', '全关返回空');
// 超长截断
const longText = 'A'.repeat(7000);
const fr4 = extractFormatRequirements({ manualText: longText, useManual: true, maxLen: 100 });
ok(fr4.length <= 120 && fr4.includes('已截断'), '超长截断');

console.log('\n== buildFixPrompt ==');
const prompt = buildFixPrompt({ originalText: SAMPLE, formatRequirements: '要求X', thinkTags: ['think', 'thinking'] });
ok(prompt.user === SAMPLE, 'user 为原文');
ok(prompt.system.includes('格式修复器'), 'system 含修复器角色');
ok(prompt.system.includes('要求X'), 'system 含格式要求');
ok(prompt.system.includes('不修改思考内容'), 'system 含不碰思考规则');
ok(prompt.system.includes('保留所有变量更新块'), 'system 含保留变量块规则');
ok(prompt.jsonSchema.properties.fixed_text.type === 'string', 'jsonSchema 含 fixed_text');
ok(prompt.jsonSchema.required.includes('changed'), 'jsonSchema required 含 changed');

console.log(`\n== 结果: ${passed} passed, ${failed} failed ==`);
if (failed > 0) process.exit(1);
