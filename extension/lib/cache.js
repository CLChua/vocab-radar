// VocabRadar - 缓存判定工具（纯函数，无 chrome / IndexedDB 依赖，可在 Node 直接单测）
//
// 缓存命中规则（v0.2.x）：
//   语言对（targetLang + sourceLang）匹配 且 translation 是有效释义（合法 JSON + 非空 definition）→ 命中。
//   phonetic **不是**命中条件：音标功能上线前的旧缓存没有 phonetic 字段，但它们仍是有效释义，
//   直接展示（只是不显示音标），绝不为补音标反复调用 DeepSeek，也不用新结果覆盖旧缓存。
//
// 兜底展示规则（API 失败 / 无 key / 离线时）：
//   只要库里存在有效释义（即使语言对与当前设置不匹配），就把它展示出来并附错误提示，
//   避免"网络一断旧释义就消失"。

// 解析缓存的 translation JSON；必须是对象且含非空 definition 才算有效释义
export function parseCachedTranslation(translationJson) {
  if (!translationJson || typeof translationJson !== 'string') return null;
  try {
    const obj = JSON.parse(translationJson);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)
      && typeof obj.definition === 'string' && obj.definition.trim().length > 0) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

// 语言对是否匹配（缓存隔离键：翻译时的 targetLang + sourceLang 都与当前设置一致才算命中）
export function isLangPairUsable(cachedTranslation, cachedLang, cachedSourceLang, targetLang, sourceLang) {
  return !!cachedTranslation && cachedLang === targetLang && cachedSourceLang === sourceLang;
}

// 综合判定：
//   serve     = true → 缓存命中，直接返回缓存（不调 API、不落库）
//   usable    = 语言对是否匹配（用于日志/分支说明）
//   cachedObj = 有效缓存对象（即使语言对不匹配也有值）→ 供 API 失败时的兜底展示
export function evaluateCache({
  cachedTranslation,
  cachedTranslationLang,
  cachedTranslationSourceLang,
  targetLang,
  sourceLang,
}) {
  const cachedObj = parseCachedTranslation(cachedTranslation);
  const usable = isLangPairUsable(
    cachedTranslation, cachedTranslationLang, cachedTranslationSourceLang, targetLang, sourceLang,
  );
  return { serve: !!(usable && cachedObj), usable, cachedObj };
}
