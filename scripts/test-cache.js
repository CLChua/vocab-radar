// VocabRadar - lib/cache.js 缓存判定逻辑单测（纯 Node，无依赖）
// 运行：node scripts/test-cache.js
// 覆盖审查意见：
//   1) 缺 phonetic 的旧缓存必须命中（不再反复调 API、不覆盖旧缓存）
//   2) API 失败 / 无 key / 离线时，旧释义仍可兜底展示

import { parseCachedTranslation, isLangPairUsable, evaluateCache } from '../extension/lib/cache.js';

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.error(`  \u2717 FAIL: ${name}`); }
}

const WITH_PHONETIC = JSON.stringify({ definition: '苹果', phonetic: '/ˈæpl/', in_context: '一种水果', example: 'An apple a day.' });
const NO_PHONETIC = JSON.stringify({ definition: '苹果', in_context: '一种水果', example: 'An apple a day.' });
const MALFORMED = '{definit';
const EN = { cachedTranslationLang: 'zh', cachedTranslationSourceLang: 'en' };

console.log('== parseCachedTranslation ==');
assert('含 phonetic 的有效缓存可解析', !!parseCachedTranslation(WITH_PHONETIC));
assert('缺 phonetic 的有效缓存仍可解析（旧缓存有效）', !!parseCachedTranslation(NO_PHONETIC));
assert('残缺 JSON → null', parseCachedTranslation(MALFORMED) === null);
assert('空字符串 → null', parseCachedTranslation('') === null);
assert('null → null', parseCachedTranslation(null) === null);
assert('无 definition 字段 → null', parseCachedTranslation(JSON.stringify({ phonetic: '/x/' })) === null);
assert('definition 为空白 → null', parseCachedTranslation(JSON.stringify({ definition: '  ' })) === null);

console.log('\n== isLangPairUsable ==');
assert('语言对匹配 → true', isLangPairUsable(NO_PHONETIC, 'zh', 'en', 'zh', 'en') === true);
assert('targetLang 不匹配 → false', isLangPairUsable(NO_PHONETIC, 'zh', 'en', 'ja', 'en') === false);
assert('sourceLang 不匹配 → false', isLangPairUsable(NO_PHONETIC, 'zh', 'en', 'zh', 'fr') === false);
assert('无缓存 → false', isLangPairUsable(null, null, null, 'zh', 'en') === false);

console.log('\n== 审查意见 1：缺 phonetic 的旧缓存必须命中（不重译、不覆盖） ==');
let r = evaluateCache({ cachedTranslation: NO_PHONETIC, ...EN, targetLang: 'zh', sourceLang: 'en' });
assert('缺 phonetic + 语言对匹配 → serve=true（不再为补音标反复调 API）', r.serve === true);
assert('  且 cachedObj 可用（可直接展示旧释义）', !!r.cachedObj);
r = evaluateCache({ cachedTranslation: WITH_PHONETIC, ...EN, targetLang: 'zh', sourceLang: 'en' });
assert('含 phonetic + 语言对匹配 → serve=true', r.serve === true);
r = evaluateCache({ cachedTranslation: NO_PHONETIC, ...EN, targetLang: 'zh', sourceLang: 'fr' });
assert('缺 phonetic + sourceLang 不匹配 → 不 serve（语义上需要重译）', r.serve === false);
r = evaluateCache({ cachedTranslation: NO_PHONETIC, ...EN, targetLang: 'ja', sourceLang: 'en' });
assert('缺 phonetic + targetLang 不匹配 → 不 serve', r.serve === false);
r = evaluateCache({ cachedTranslation: MALFORMED, ...EN, targetLang: 'zh', sourceLang: 'en' });
assert('缓存损坏 → 不 serve（重译后覆盖坏缓存）', r.serve === false && r.cachedObj === null);

console.log('\n== 审查意见 2：无 key / 网络失败 / 离线时，旧释义仍可兜底展示 ==');
r = evaluateCache({ cachedTranslation: NO_PHONETIC, ...EN, targetLang: 'ja', sourceLang: 'en' });
assert('语言对不匹配的旧缓存也能兜底展示（有 cachedObj）', !!r.cachedObj);
r = evaluateCache({ cachedTranslation: WITH_PHONETIC, ...EN, targetLang: 'zh', sourceLang: 'en' });
assert('语言对匹配的旧缓存也能兜底展示', !!r.cachedObj);
r = evaluateCache({ cachedTranslation: null, cachedTranslationLang: null, cachedTranslationSourceLang: null, targetLang: 'zh', sourceLang: 'en' });
assert('无缓存时无兜底（走纯错误提示）', r.cachedObj === null && r.serve === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
