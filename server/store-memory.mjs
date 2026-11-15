/** 메모리 저장소. 로컬 실행과 테스트에서 DynamoDB 대신 쓴다. 메서드는 store-dynamo.mjs와 같다. */
const copy = (o) => JSON.parse(JSON.stringify(o));

export function createMemoryStore(seed = {}) {
  const items = new Map((seed.items || []).map((i) => [i.id, copy(i)]));
  const sessions = new Map((seed.sessions || []).map((s) => [s.id, copy(s)]));
  return {
    async listItems() { return [...items.values()].map(copy); },
    async getItem(id) { return items.has(id) ? copy(items.get(id)) : null; },
    async putItem(item) { items.set(item.id, copy(item)); },
    async patchItem(id, patch) {
      if (!items.has(id)) return null;
      const next = { ...items.get(id), ...copy(patch) };
      items.set(id, next);
      return copy(next);
    },
    async deleteItem(id) { items.delete(id); },
    async listSessions(limit = 120) {
      return [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map(copy);
    },
    async putSession(id, doc) { sessions.set(id, { id, ...copy(doc) }); },
  };
}
