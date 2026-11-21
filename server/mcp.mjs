/**
 * MCP 서버 (Streamable HTTP, 상태 없음).
 * 요청 하나에 JSON 응답 하나를 돌려주는 가장 단순한 형태다. SSE 스트림과 세션은 쓰지 않는다.
 * 규격: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * 도구는 두 개다.
 *   add_items  (쓰기)      단어·표현 등록
 *   find_items (읽기 전용) 등록된 항목 검색
 * 수정·삭제 도구는 일부러 두지 않았다. 서버 주소가 새더라도 기록이 지워지지 않게 하기 위해서다.
 */
import { addItems, findItems } from './service.mjs';
import * as rewinds from './rewinds.mjs';

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'rewind', title: 'Rewind 영어 복습', version: '1.0.0' };

const INSTRUCTIONS = [
  'Rewind is the user\'s personal English review app. Use add_items to save words and expressions the user wants to review, and find_items to check what is already saved.',
  'Before calling add_items, make sure you know WHICH words or expressions the user wants.',
  '- If the user named the target, or just asked you about that expression, save only that and set picked_by to "user".',
  '- If the user only pasted a sentence and said "save this", do NOT guess: list candidate expressions (base form + one-line Korean meaning), ask which ones to save, then save only the chosen ones with picked_by "user".',
  '- If the user says "pick for me", set picked_by to "assistant". Those items arrive as candidates and stay out of study sessions until the user accepts them in the app.',
  'Fill in as many fields as you can. The app builds its quizzes from examples, synonyms, antonyms, wrong_meanings_ko and wrong_fills.',
  'The word list is organized as expression → senses. One expression (dictionary base form) can have several meanings; each meaning is studied separately. Inflected forms (applied, applying) belong to the base form (apply).',
  '- Before adding an expression that may already be saved, call find_items. To add examples to an existing meaning, pass its id as sense_id. To add a different meaning, set new_sense: true.',
  '- The user practices SPEAKING. Write examples the user could say or write as-is, in the register that fits the expression (casual conversation, business, finance, news...), and set register.',
  'REWINDS (리와인즈, "최적화", "정제"): when the user asks to run rewinds, improve the word list toward its goal.',
  '1. Call rewinds_targets. Each target is one meaning with its current content and its gaps.',
  '2. For each target, fix every gap: set register; bring examples to about 10 in different situations, in that register, with [ ] around the target and a natural Korean translation; replace every overexposed example with a new one for the same situation (replace_examples with its key); add 2-3 contrasts (a confusable expression, when to use which in Korean, and one sentence where that one fits); add collocations; add 3 wrong meanings and 3 wrong fills.',
  '3. trends ("요즘 활용 문장", 2-3 sentences): for news, finance, business or tech expressions, SEARCH current news/trends and write sentences tied to them, with topic, source, url and date. For everyday expressions, do not search; write fresh sentences from everyday life today. Not everything needs news.',
  '4. If two targets are duplicates, or one is only an inflected form of another (applied vs apply), merge with merge_into instead of editing both.',
  '5. Send ALL fixes in ONE rewinds_apply call. Then tell the user, in Korean, how many meanings you improved and what changed, and the run_id. If the user is unhappy, rewinds_undo with that run_id (or one change_id from rewinds_history).',
  'Never invent progress or remove the original source sentence; the server keeps study progress untouched.',
].join('\n');

const relation = {
  type: 'array', maxItems: 8,
  items: { type: 'object', properties: { text: { type: 'string' }, note: { type: 'string', description: 'One short Korean line on how it differs from the target.' } }, required: ['text'] },
};

export const TOOLS = [
  {
    name: 'add_items',
    title: '단어·표현 등록',
    description: [
      'Save English words or expressions to the user\'s review app. Call this when the user asks to save/register an expression ("등록해 줘", "저장해 줘", "넣어 줘").',
      'Only save what the user chose. If they pasted a sentence without saying which expression they want, first show candidates and ask (see picked_by).',
      'Expressions are matched by base form and known inflected forms. Within an expression, a meaning is chosen by sense_id, then new_sense, then an identical meaning_ko; otherwise a new meaning is added and a warning tells you, so you can resend with sense_id if it was the same meaning.',
      'The result lists, per item, the meaning id (sense) and whether it was created, merged, new_sense, accepted (a candidate the user has now chosen) or stored as a candidate, plus warnings you can fix by calling again.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        picked_by: {
          type: 'string', enum: ['user', 'assistant'],
          description: 'Who chose these items. "user": the user named them or picked them from your candidate list. "assistant": you picked them yourself. Items not marked "user" are stored as candidates that the user must accept in the app. Can also be set per item.',
        },
        source: {
          type: 'object',
          description: 'The original sentence the items came from (a line from a show, an article...). Optional. Items from the same source are introduced together.',
          properties: {
            text: { type: 'string', description: 'The original English sentence(s), verbatim.' },
            ko: { type: 'string', description: 'Natural Korean translation.' },
            origin: { type: 'string', description: 'Title of the show/book, if known. Otherwise empty.' },
          },
          required: ['text'],
        },
        items: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['word', 'phrase'], description: '"word" for a single word, "phrase" for an expression or pattern of two or more words.' },
              text: { type: 'string', description: 'Dictionary base form. For patterns mark slots with someone / something, e.g. "set someone up with something", "keep one\'s head down".' },
              forms: { type: 'array', maxItems: 12, items: { type: 'string' }, description: 'Inflected forms of the base form, e.g. ["applied", "applies", "applying"]. Optional.' },
              sense_id: { type: 'string', description: 'id of an existing meaning (from find_items) to add examples/synonyms to. Omit for a new expression.' },
              new_sense: { type: 'boolean', description: 'true when this is a different meaning of an expression that is already saved.' },
              register: { type: 'string', description: 'Tone of this meaning: casual, business, finance, news, formal, academic, slang... Examples should match it.' },
              ipa: { type: 'string', description: 'IPA pronunciation for single words, e.g. "/ˈɡɔːrdʒəs/".' },
              meaning_ko: { type: 'string', description: 'Korean meaning in one short line.' },
              note: { type: 'string', description: 'Nuance, register or usage caveats in one or two Korean sentences.' },
              examples: {
                type: 'array', maxItems: 8,
                description: 'At least 2 for a word, at least 3 for a phrase, each in a different situation. Wrap the part of the sentence that realizes the target in [ ] so the app can blank it out, e.g. "Can you [set] me [up with] a drink?". Bracket only the part that stays the same across examples.',
                items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string', description: 'Korean translation.' } }, required: ['en'] },
              },
              synonyms: relation,
              antonyms: relation,
              wrong_meanings_ko: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Three plausible but wrong Korean meanings, used as distractors.' },
              wrong_fills: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Three wrong but similar-looking fills for the blanked part of the examples, in the same shape as the bracketed text (e.g. "put … up with").' },
              priority: { type: 'boolean', description: 'true if the user wants to learn this one first.' },
              picked_by: { type: 'string', enum: ['user', 'assistant'], description: 'Overrides the top-level picked_by for this item.' },
              source: { type: 'object', description: 'Overrides the top-level source for this item.', properties: { text: { type: 'string' }, ko: { type: 'string' }, origin: { type: 'string' } }, required: ['text'] },
            },
            required: ['text', 'meaning_ko'],
          },
        },
      },
      required: ['items'],
    },
    annotations: { title: '단어·표현 등록', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'find_items',
    title: '등록된 항목 검색',
    description: 'Search the words and expressions already saved in the user\'s review app. Use it to check whether an expression is already saved before adding it, or to answer "what have I saved?". An empty query returns the most recently saved items. Each result is one meaning: id is the meaning id (pass it as sense_id to add to that meaning), sense/senses tell which meaning of how many, forms are known inflected forms. state is one of: candidate (waiting for the user to accept), queued (saved, not started), learning, familiar, off.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the English text or the Korean meaning. Empty for the most recent items.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of items. Default 20.' },
      },
    },
    annotations: { title: '등록된 항목 검색', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'rewinds_targets',
    title: 'rewinds: 고칠 뜻 꺼내기',
    description: 'First step of rewinds (단어장 최적화). Returns the meanings that fall short of the word-list goal, most urgent first, each with its current content (examples with key and how many times shown), its gaps, and overexposed examples to replace. Read the server instructions for how to fix each gap, then send all fixes in one rewinds_apply call.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 15, description: 'How many meanings to fix this time. Default 10.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Only these meaning ids or expression ids (e.g. when the user names words to refine).' },
      },
    },
    annotations: { title: 'rewinds: 고칠 뜻 꺼내기', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'rewinds_apply',
    title: 'rewinds: 한 번에 고치기',
    description: 'Second step of rewinds. Applies all fixes at once, immediately (no approval). Study progress is never changed; every change is logged and can be undone with rewinds_undo. Per meaning: "set" replaces the given fields; examples are edited with remove_examples (keys), replace_examples ({key, en, ko}) and add_examples ({en, ko}); max 12 examples. Use merge_into to merge a duplicate meaning (or an inflected-form entry) into another meaning; progress keeps whichever of the two was studied more, per person.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One line about this run (optional).' },
        updates: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              sense_id: { type: 'string', description: 'Meaning id from rewinds_targets.' },
              merge_into: { type: 'string', description: 'Merge this meaning into that meaning id instead of editing it.' },
              set: {
                type: 'object',
                properties: {
                  meaning_ko: { type: 'string' }, register: { type: 'string', description: 'casual, business, finance, news, formal, academic, slang...' },
                  note: { type: 'string', description: 'Nuance and usage in Korean, 1-3 sentences.' },
                  collocations: { type: 'array', maxItems: 8, items: { type: 'string' } },
                  contrasts: {
                    type: 'array', maxItems: 4, description: 'Confusable expressions: when to use which, and a sentence where THAT expression fits.',
                    items: { type: 'object', properties: { text: { type: 'string' }, when_ko: { type: 'string' }, example: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } } } }, required: ['text', 'when_ko'] },
                  },
                  trends: {
                    type: 'array', maxItems: 4, description: 'Current-usage sentences. For news/finance/business/tech expressions, tie them to current news you searched (topic, source, url, date). For everyday expressions, fresh everyday scenes (topic only).',
                    items: { type: 'object', properties: { en: { type: 'string', description: 'Put [ ] around the target.' }, ko: { type: 'string' }, topic: { type: 'string' }, source: { type: 'string' }, url: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['en'] },
                  },
                  wrong_meanings_ko: { type: 'array', maxItems: 6, items: { type: 'string' } },
                  wrong_fills: { type: 'array', maxItems: 6, items: { type: 'string' } },
                  synonyms: { type: 'array', maxItems: 8, items: { type: 'object', properties: { text: { type: 'string' }, note: { type: 'string' } }, required: ['text'] } },
                  antonyms: { type: 'array', maxItems: 8, items: { type: 'object', properties: { text: { type: 'string' }, note: { type: 'string' } }, required: ['text'] } },
                  ipa: { type: 'string' }, forms: { type: 'array', items: { type: 'string' }, description: 'Inflected forms to add to the expression.' },
                },
              },
              add_examples: { type: 'array', maxItems: 12, items: { type: 'object', properties: { en: { type: 'string' }, ko: { type: 'string' } }, required: ['en'] } },
              replace_examples: { type: 'array', maxItems: 12, items: { type: 'object', properties: { key: { type: 'string' }, en: { type: 'string' }, ko: { type: 'string' } }, required: ['key', 'en'] } },
              remove_examples: { type: 'array', maxItems: 12, items: { type: 'string' }, description: 'Example keys to remove.' },
            },
            required: ['sense_id'],
          },
        },
      },
      required: ['updates'],
    },
    annotations: { title: 'rewinds: 한 번에 고치기', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'rewinds_history',
    title: 'rewinds: 고친 기록',
    description: 'Recent rewinds runs and their changes (run_id, change_id, what changed, whether undone).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } } },
    annotations: { title: 'rewinds: 고친 기록', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'rewinds_undo',
    title: 'rewinds: 되돌리기',
    description: 'Undo a whole rewinds run (run_id) or one change (change_id). A meaning that was edited again afterwards is not overwritten; the result says so.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, change_id: { type: 'string' } } },
    annotations: { title: 'rewinds: 되돌리기', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const STATUS_KO = {
  created: '새로 등록했습니다. 다음 세션부터 나옵니다',
  merged: '이미 있는 항목에 내용을 합쳤습니다',
  accepted: '후보였던 항목을 학습에 넣었습니다',
  candidate: '후보로 저장했습니다. 사용자가 앱에서 켜야 학습에 나옵니다',
  new_sense: '이미 있는 표현에 새 뜻으로 추가했습니다',
};

async function callTool(name, args, { store, now, user }) {
  if (name === 'add_items') {
    if (!args || !Array.isArray(args.items) || !args.items.length) {
      return { isError: true, content: [{ type: 'text', text: 'items 배열이 필요합니다. 항목마다 text와 meaning_ko는 꼭 넣어야 합니다.' }] };
    }
    const r = await addItems(store, args, now);
    const out = { results: r.results, errors: r.errors, warnings: r.warnings };
    const lines = r.results.map((x) => `- ${x.text}${x.sense > 1 ? ` (뜻 ${x.sense}: ${x.meaning_ko})` : ''} [${x.id}]: ${STATUS_KO[x.status]}`)
      .concat(r.errors.map((e) => `- 거절: ${e}`), r.warnings.map((w) => `- 경고: ${w}`));
    return {
      isError: r.results.length === 0,
      content: [{ type: 'text', text: lines.join('\n') || '등록된 항목이 없습니다.' }],
      structuredContent: out,
    };
  }
  if (name === 'find_items') {
    const items = await findItems(store, args && args.query, (args && args.limit) || 20, user);
    return {
      content: [{ type: 'text', text: items.length ? JSON.stringify(items) : '일치하는 항목이 없습니다.' }],
      structuredContent: { items },
    };
  }
  if (name.startsWith('rewinds_')) {
    if (!user || user.role !== 'owner') {
      if (name === 'rewinds_apply' || name === 'rewinds_undo') return { isError: true, content: [{ type: 'text', text: '단어장을 고치는 것은 주인만 할 수 있습니다.' }] };
    }
    const out = name === 'rewinds_targets' ? await rewinds.targets(store, args || {}, now)
      : name === 'rewinds_apply' ? await rewinds.apply(store, args || {}, now)
      : name === 'rewinds_history' ? await rewinds.history(store, args || {})
      : name === 'rewinds_undo' ? await rewinds.undo(store, args || {}, now) : null;
    if (!out) return null;
    const text = name === 'rewinds_targets' ? `고칠 뜻 ${out.targets.length}개 (모자란 칸이 있는 뜻은 모두 ${out.total_with_gaps}개). 오늘: ${out.today}`
      : name === 'rewinds_apply' ? `run_id ${out.run_id}: ${out.results.filter((r) => r.change_id).length}개 고침` + (out.errors.length ? `, 거절 ${out.errors.length}개: ${out.errors.join(' / ')}` : '') + (out.warnings.length ? `, 경고: ${out.warnings.join(' / ')}` : '')
      : name === 'rewinds_undo' ? `되돌림 ${out.undone.length}개` + (out.skipped.length ? `, 못 되돌림 ${out.skipped.length}개: ${out.skipped.map((x) => x.reason).join(' / ')}` : '')
      : `최근 실행 ${out.runs.length}개`;
    return { isError: name === 'rewinds_apply' && out.results.every((r) => !r.change_id) && out.errors.length > 0, content: [{ type: 'text', text: text + '\n' + JSON.stringify(out) }], structuredContent: out };
  }
  return null;
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * JSON-RPC 메시지 하나를 처리한다.
 * @returns {{status: number, json?: object}} status 202는 본문 없는 응답(알림을 받았다는 뜻).
 */
export async function handleMcp(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, json: rpcError(null, -32600, 'JSON-RPC 메시지 하나를 보내야 합니다.') };
  }
  const { id, method, params } = message;
  if (message.jsonrpc !== '2.0') return { status: 400, json: rpcError(id, -32600, 'jsonrpc는 "2.0"이어야 합니다.') };
  // 알림(id 없음)과 클라이언트의 응답(method 없음)은 받았다는 표시만 한다
  if (id === undefined || id === null || typeof method !== 'string') return { status: 202 };

  try {
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
      };
    }
    if (method === 'ping') return { status: 200, json: rpcResult(id, {}) };
    if (method === 'tools/list') return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    if (method === 'tools/call') {
      const name = params && params.name;
      const result = await callTool(name, (params && params.arguments) || {}, ctx);
      if (!result) return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${name}`) };
      return { status: 200, json: rpcResult(id, result) };
    }
    return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
  } catch (e) {
    console.error('mcp error', e);
    return { status: 200, json: rpcError(id, -32603, '서버에서 처리하지 못했습니다.') };
  }
}
