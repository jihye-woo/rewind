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

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'rewind', title: 'Rewind 영어 복습', version: '1.0.0' };

const INSTRUCTIONS = [
  'Rewind is the user\'s personal English review app. Use add_items to save words and expressions the user wants to review, and find_items to check what is already saved.',
  'Before calling add_items, make sure you know WHICH words or expressions the user wants.',
  '- If the user named the target, or just asked you about that expression, save only that and set picked_by to "user".',
  '- If the user only pasted a sentence and said "save this", do NOT guess: list candidate expressions (base form + one-line Korean meaning), ask which ones to save, then save only the chosen ones with picked_by "user".',
  '- If the user says "pick for me", set picked_by to "assistant". Those items arrive as candidates and stay out of study sessions until the user accepts them in the app.',
  'Fill in as many fields as you can. The app builds its quizzes from examples, synonyms, antonyms, wrong_meanings_ko and wrong_fills.',
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
      'Saving the same expression again merges new examples and synonyms into the existing item; it never creates a duplicate.',
      'The result lists, per item, whether it was created, merged, accepted (a candidate the user has now chosen) or stored as a candidate, plus warnings you can fix by calling again.',
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
    description: 'Search the words and expressions already saved in the user\'s review app. Use it to check whether an expression is already saved before adding it, or to answer "what have I saved?". An empty query returns the most recently saved items. state is one of: candidate (waiting for the user to accept), queued (saved, not started), learning, familiar, off.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the English text or the Korean meaning. Empty for the most recent items.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of items. Default 20.' },
      },
    },
    annotations: { title: '등록된 항목 검색', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const STATUS_KO = {
  created: '새로 등록했습니다. 다음 세션부터 나옵니다',
  merged: '이미 있는 항목에 내용을 합쳤습니다',
  accepted: '후보였던 항목을 학습에 넣었습니다',
  candidate: '후보로 저장했습니다. 사용자가 앱에서 켜야 학습에 나옵니다',
};

async function callTool(name, args, { store, now, user }) {
  if (name === 'add_items') {
    if (!args || !Array.isArray(args.items) || !args.items.length) {
      return { isError: true, content: [{ type: 'text', text: 'items 배열이 필요합니다. 항목마다 text와 meaning_ko는 꼭 넣어야 합니다.' }] };
    }
    const r = await addItems(store, args, now);
    const out = { results: r.results, errors: r.errors, warnings: r.warnings };
    const lines = r.results.map((x) => `- ${x.text}: ${STATUS_KO[x.status]}`)
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
