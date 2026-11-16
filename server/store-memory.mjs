/** 메모리 저장소. 로컬 실행과 테스트에서 DynamoDB 대신 쓴다. 메서드는 store-dynamo.mjs와 같다. */
const copy = (o) => JSON.parse(JSON.stringify(o));

export function createMemoryStore(seed = {}) {
  const items = new Map((seed.items || []).map((i) => [i.id, copy(i)]));
  const sessions = new Map((seed.sessions || []).map((s) => ['owner|' + s.id, { uid: 'owner', ...copy(s) }]));
  const docs = new Map(); // "pk|sk" → doc
  const states = new Map(); // uid → Map(항목 ID → { st?, off? })
  const owner = (uid) => uid || 'owner';
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
    async listSessions(limit = 120, uid) {
      return [...sessions.values()].filter((s) => s.uid === owner(uid)).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
        .map(({ uid: _, ...s }) => copy(s));
    },
    async putSession(id, doc, uid) { sessions.set(owner(uid) + '|' + id, { id, ...copy(doc), uid: owner(uid) }); },
    async listStates(uid) { return Object.fromEntries([...(states.get(uid) || new Map())].map(([k, v]) => [k, copy(v)])); },
    async getStateRow(uid, id) { const m = states.get(uid); return m && m.has(id) ? copy(m.get(id)) : null; },
    async patchState(uid, id, fields) {
      if (!states.has(uid)) states.set(uid, new Map());
      const m = states.get(uid); m.set(id, { ...(m.get(id) || {}), ...copy(fields) });
    },
    async getDoc(pk, sk) { return docs.has(pk + '|' + sk) ? copy(docs.get(pk + '|' + sk)) : null; },
    async putDoc(pk, sk, doc) { docs.set(pk + '|' + sk, copy(doc)); },
    async deleteDoc(pk, sk) { docs.delete(pk + '|' + sk); },
    async listDocs(pk) { return [...docs].filter(([k]) => k.startsWith(pk + '|')).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d]) => copy(d)); },
    async claimInvite(sk, now, uid) {
      const d = docs.get('INVITE|' + sk);
      if (!d || d.usedAt != null || !(d.expiresAt > now)) return null;
      d.usedAt = now; d.uid = uid; return copy(d);
    },
  };
}

/** 접속 기록 메모리 저장소. 메서드는 store-dynamo.mjs 의 createDynamoTraffic 과 같다. */
export function createMemoryTraffic() {
  const rows = new Map();
  return {
    async recordVisit({ ip, kind, ua, path, who, now }) {
      const r = rows.get(ip) || { ip, firstSeen: now };
      r.lastSeen = now; r.ua = ua || '';
      if ((kind === 'app' || kind === 'mcp') && r['firstKey_' + kind] == null) r['firstKey_' + kind] = now;
      if (path) r.lastPath = path;
      if (who) r.who = who;
      r['n_' + kind] = (r['n_' + kind] || 0) + 1;
      rows.set(ip, r);
    },
    async listVisits(limit = 300) { return [...rows.values()].map(copy).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit); },
  };
}
