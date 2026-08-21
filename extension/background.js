// VocabRadar - background service worker (client-only mode)
// 所有数据在 IndexedDB；DeepSeek 直接从这里调；无远程后端。

import {
  logLookupEvent, upsertWord, saveTranslation,
  listLearningWords, updateWordStatus, getStats,
  deleteWord, exportAll, importAll,
} from './lib/db.js';
import { getSettings, saveSettings, SUPPORTED_LANGS } from './lib/settings.js';
import { streamTranslate, testApiKey } from './lib/deepseek.js';
import { loadTranslations, t } from './lib/i18n.js';
import { evaluateCache } from './lib/cache.js';

async function getNoKeyErrorMessage(lang) {
  try {
    const trs = await loadTranslations();
    return t(trs, 'lookup.error.noKey', lang || 'zh');
  } catch (_) {
    return 'API key not configured';
  }
}

// API 失败 / 无 key / 离线时，兜底展示旧释义的说明文案
async function getCachedFallbackNote(lang) {
  try {
    const trs = await loadTranslations();
    return t(trs, 'lookup.error.cachedFallback', lang || 'zh');
  } catch (_) {
    return 'Showing cached translation';
  }
}

// 把缓存的完整 translation JSON 作为单帧发给 content.js（与命中路径的 fakeChunk 格式一致）
function sendCachedContent(port, cachedTranslation) {
  const fakeChunk = {
    choices: [{ delta: { content: cachedTranslation }, finish_reason: 'stop' }],
  };
  port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify(fakeChunk)}\n\n` });
}

// ====== content.js 通过 chrome.runtime.connect({name:'translate'}) 建长连接走流式 ======

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;

  let aborted = false;
  port.onDisconnect.addListener(() => { aborted = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'start') return;
    const { word, context, sourceUrl, pageTitle } = msg.payload || {};

    try {
      // 1) 写 lookup_events + upsert words（与原后端 /translate 同序）
      await logLookupEvent({ word, context, sourceUrl, pageTitle });
      const upsertResult = await upsertWord({ word, context, sourceUrl });
      const meta = { status: upsertResult.status, lookup_count: upsertResult.lookup_count };
      const cachedTranslation = upsertResult.cachedTranslation;
      const cachedTranslationLang = upsertResult.cachedTranslationLang;
      const cachedTranslationSourceLang = upsertResult.cachedTranslationSourceLang;
      if (upsertResult.demoted) {
        console.log(`[VocabRadar] 自动降级 word="${word}" 已认识/已掌握 → learning（用户又在查）`);
      }

      // 2) 把 meta 包成 SSE 格式发给 content.js（保持原协议不变）
      port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ meta })}\n\n` });

      // 2.5) 缓存判定：语言对（targetLang + sourceLang）匹配 且 translation 是有效释义 → 直接命中。
      //      注意：phonetic **不是**命中条件。音标功能上线前的旧缓存没有 phonetic 字段，但它们仍是
      //      有效释义，直接展示（只是不显示音标）；绝不因为缺音标就反复调 API，也不覆盖旧缓存。
      //      语言对不匹配（用户切换 targetLang/sourceLang）或无缓存时才重新调 DeepSeek。
      const settings = await getSettings();
      const cache = evaluateCache({
        cachedTranslation,
        cachedTranslationLang,
        cachedTranslationSourceLang,
        targetLang: settings.targetLang,
        sourceLang: settings.sourceLang,
      });
      if (cache.serve) {
        // 命中缓存但没配 key：附一条提示，避免用户误以为看到的是实时新释义
        if (!settings.apiKey) {
          const note = await getNoKeyErrorMessage(settings.targetLang);
          port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ error: note })}\n\n` });
        }
        sendCachedContent(port, cachedTranslation);
        port.postMessage({ type: 'chunk', data: 'data: [DONE]\n\n' });
        port.postMessage({ type: 'done' });
        console.log(`[VocabRadar] 缓存命中 word="${word}" lang=${cachedTranslationLang}/${cachedTranslationSourceLang} 跳过 DeepSeek`);
        try { port.disconnect(); } catch (_) {}
        return;
      }
      if (cachedTranslation && !cache.usable) {
        console.log(`[VocabRadar] 缓存语言对不匹配 word="${word}" cached=${cachedTranslationLang}/${cachedTranslationSourceLang} now=${settings.targetLang}/${settings.sourceLang} → 重译`);
      }

      // 3) 校验 settings.apiKey 存在；不存在 → 报错；若库里还有旧释义，一并展示（不丢旧数据）
      if (!settings.apiKey) {
        // i18n 这条错误：从 translations.json 拿对应语言；fallback 中文
        const errMsg = await getNoKeyErrorMessage(settings.targetLang);
        // 有旧缓存释义 → 先展示它（用户仍能看到释义），再附错误提示说明为什么不是新的
        if (cache.cachedObj) {
          const note = `${errMsg} — ${await getCachedFallbackNote(settings.targetLang)}`;
          port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ error: note })}\n\n` });
          sendCachedContent(port, cachedTranslation);
        } else {
          port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ error: errMsg })}\n\n` });
        }
        port.postMessage({ type: 'chunk', data: 'data: [DONE]\n\n' });
        port.postMessage({ type: 'done' });
        try { port.disconnect(); } catch (_) {}
        return;
      }

      // 4) 调 DeepSeek 流，逐行透传 + 同时 buffer 出 content
      const contentBuffer = [];
      let lineCount = 0;
      const t0 = Date.now();
      try {
        for await (const line of streamTranslate({ word, context, settings })) {
          if (aborted) break;
          lineCount++;
          if (line === 'data: [DONE]') continue; // 我们自己最后单发
          if (line.startsWith('data:')) {
            // 抽 delta.content 落 buffer
            const payload = line.slice(5).trim();
            try {
              const obj = JSON.parse(payload);
              const part = obj?.choices?.[0]?.delta?.content;
              if (typeof part === 'string' && part) contentBuffer.push(part);
            } catch (_) {}
          }
          port.postMessage({ type: 'chunk', data: line + '\n\n' });
        }
        const dt = Date.now() - t0;
        const totalChars = contentBuffer.join('').length;
        console.log(`[VocabRadar] DeepSeek 完成 word="${word}" 耗时=${dt}ms 行=${lineCount} 字符=${totalChars}`);
        if (totalChars === 0) {
          // DeepSeek 返回了 200 但没产出任何内容 —— 透传一个 error chunk 让前端可见；
          // 若库里还有旧释义则一并展示（网络/模型异常时旧释义不消失）
          const emptyMsg = 'DeepSeek 返回了空内容（无 delta.content）';
          const note = cache.cachedObj
            ? `${emptyMsg} — ${await getCachedFallbackNote(settings.targetLang)}`
            : emptyMsg;
          port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ error: note })}\n\n` });
          if (cache.cachedObj) sendCachedContent(port, cachedTranslation);
        }
      } catch (err) {
        const errMsg = String(err.message || err);
        console.warn(`[VocabRadar] DeepSeek 调用失败 word="${word}":`, errMsg);
        // 网络失败 / 离线 / HTTP 错误：保留并展示旧缓存释义，而不是只给一条错误
        const short = errMsg.slice(0, 200);
        const note = cache.cachedObj
          ? `${short} — ${await getCachedFallbackNote(settings.targetLang)}`
          : short;
        port.postMessage({ type: 'chunk', data: `data: ${JSON.stringify({ error: note })}\n\n` });
        if (cache.cachedObj) sendCachedContent(port, cachedTranslation);
      }

      port.postMessage({ type: 'chunk', data: 'data: [DONE]\n\n' });
      port.postMessage({ type: 'done' });

      // 5) 落库 translation（fire-and-forget；失败不影响用户）
      //    保存 targetLang + sourceLang 两个维度，作为后续缓存命中的隔离键
      const full = contentBuffer.join('').trim();
      if (full && !aborted) {
        try {
          JSON.parse(full); // 验证完整 JSON
          await saveTranslation(word, full, settings.targetLang, settings.sourceLang);
        } catch (_) { /* malformed JSON, skip */ }
      }
    } catch (err) {
      try {
        port.postMessage({
          type: 'error',
          error: String(err.message || err).slice(0, 200),
        });
      } catch (_) {}
    } finally {
      try { port.disconnect(); } catch (_) {}
    }
  });
});

// ====== 一次性消息：getHighlightWords / updateWordStatus / getStats / settings ======

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'getHighlightWords': {
          const list = await listLearningWords();
          sendResponse({ ok: true, data: { highlight_words: list } });
          break;
        }
        case 'updateWordStatus': {
          const r = await updateWordStatus(msg.word, msg.status);
          if (!r) { sendResponse({ ok: false, error: 'word not found' }); break; }
          sendResponse({ ok: true, data: r });
          break;
        }
        case 'deleteWord': {
          await deleteWord(msg.word);
          sendResponse({ ok: true });
          break;
        }
        case 'getStats': {
          const s = await getStats();
          sendResponse({ ok: true, data: s });
          break;
        }
        case 'getSettings': {
          const s = await getSettings();
          sendResponse({ ok: true, data: s, supportedLangs: SUPPORTED_LANGS });
          break;
        }
        case 'saveSettings': {
          const next = await saveSettings(msg.patch || {});
          sendResponse({ ok: true, data: next });
          break;
        }
        case 'testApiKey': {
          const settings = await getSettings();
          const merged = { ...settings, ...(msg.patch || {}) };
          const r = await testApiKey({
            apiKey: merged.apiKey,
            apiBaseUrl: merged.apiBaseUrl,
            model: merged.model,
          });
          sendResponse(r);
          break;
        }
        case 'exportAll': {
          const data = await exportAll();
          sendResponse({ ok: true, data });
          break;
        }
        case 'importAll': {
          const r = await importAll(msg.payload);
          sendResponse({ ok: true, data: r });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown msg type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err).slice(0, 300) });
    }
  })();
  return true; // async
});

// ====== 首次安装：打开 onboarding 页 ======
// ====== 扩展更新：自动给所有 http(s) tab 重新注入 content.js（kill-switch 替换旧实例）
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
  if (details.reason === 'update' || details.reason === 'install') {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        if (!/^https?:/.test(tab.url)) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            files: ['content.js'],
          });
        } catch (_) {
          // chrome 商店、PDF viewer 等会拒绝注入；正常忽略
        }
      }
    } catch (e) {
      console.warn('[VocabRadar] re-inject sweep failed', e);
    }
  }
});
