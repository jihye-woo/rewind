/**
 * DynamoDB 저장소. 테이블 하나에 두 종류의 행을 둔다.
 *   pk = "ITEM",    sk = 항목 ID        doc = 항목 전체
 *   pk = "SESSION", sk = 세션 ID(s+시작 시각)  doc = 세션 로그 (주인)
 *   pk = "SESSION#<uid>"                      doc = 세션 로그 (초대받은 사람)
 *   pk = "ST#<uid>", sk = 항목 ID              st, off = 그 사람의 학습 상태 (최상위 속성)
 *   pk = "USER" | "TOKEN" | "INVITE" | "MCPKEY" doc = 사람·기기 열쇠·초대 코드·MCP 키 (users.mjs)
 * 단어 내용은 모두가 같이 쓰고, 학습 진도만 사람마다 따로 둔다.
 * 주인의 학습 상태는 예전처럼 항목 문서(doc.st, doc.off)에도 남아 있고, ST#owner 행이 있으면 그쪽이 우선한다.
 */
const sessionPk = (uid) => (!uid || uid === 'owner' ? 'SESSION' : 'SESSION#' + uid);
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export function createDynamoStore({ tableName, client }) {
  const base = client || new DynamoDBClient({});
  const db = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });

  /** 한 pk의 행을 끝까지 읽는다. DynamoDB는 한 번에 1MB까지만 주므로 이어 읽는다. */
  async function queryAll(pk, { forward = true, limit = Infinity, raw = false } = {}) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: forward, ExclusiveStartKey, ...(Number.isFinite(limit) ? { Limit: limit - out.length } : {}),
      }));
      for (const row of r.Items || []) out.push(raw ? row : row.doc);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < limit);
    return out;
  }

  return {
    async listItems() { return queryAll('ITEM'); },
    async getItem(id) {
      const r = await db.send(new GetCommand({ TableName: tableName, Key: { pk: 'ITEM', sk: id } }));
      return r.Item ? r.Item.doc : null;
    },
    async putItem(item) {
      await db.send(new PutCommand({ TableName: tableName, Item: { pk: 'ITEM', sk: item.id, doc: item } }));
    },
    /** 학습 상태만 바꾼다. 같은 시각에 MCP가 등록 내용을 합쳐도 서로 덮어쓰지 않는다. */
    async patchItem(id, patch) {
      const names = { '#doc': 'doc' }, values = {}, sets = [];
      Object.keys(patch).forEach((k, i) => { names[`#k${i}`] = k; values[`:v${i}`] = patch[k]; sets.push(`#doc.#k${i} = :v${i}`); });
      try {
        const r = await db.send(new UpdateCommand({
          TableName: tableName, Key: { pk: 'ITEM', sk: id },
          UpdateExpression: 'SET ' + sets.join(', '), ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW',
        }));
        return r.Attributes.doc;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return null; // 없는 항목
        throw e;
      }
    },
    async deleteItem(id) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: 'ITEM', sk: id } }));
    },
    /** 세션 ID가 시작 시각이라 sk 역순이 곧 최신순이다. */
    async listSessions(limit = 120, uid) { return queryAll(sessionPk(uid), { forward: false, limit }); },
    async putSession(id, doc, uid) {
      await db.send(new PutCommand({ TableName: tableName, Item: { pk: sessionPk(uid), sk: id, doc: { id, ...doc } } }));
    },

    /** 사람별 학습 상태. { 항목 ID: { st?, off? } } */
    async listStates(uid) {
      const rows = await queryAll('ST#' + uid, { raw: true });
      return Object.fromEntries(rows.map(({ pk, sk, ...rest }) => [sk, rest]));
    },
    async getStateRow(uid, id) {
      const r = await db.send(new GetCommand({ TableName: tableName, Key: { pk: 'ST#' + uid, sk: id } }));
      if (!r.Item) return null;
      const { pk, sk, ...rest } = r.Item; return rest;
    },
    async patchState(uid, id, fields) {
      const names = {}, values = {}, sets = [];
      Object.keys(fields).forEach((k, i) => { names[`#k${i}`] = k; values[`:v${i}`] = fields[k]; sets.push(`#k${i} = :v${i}`); });
      await db.send(new UpdateCommand({
        TableName: tableName, Key: { pk: 'ST#' + uid, sk: id },
        UpdateExpression: 'SET ' + sets.join(', '), ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
    },

    /** 사람·열쇠·초대 같은 작은 문서. */
    async getDoc(pk, sk) {
      const r = await db.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
      return r.Item ? r.Item.doc : null;
    },
    async putDoc(pk, sk, doc) { await db.send(new PutCommand({ TableName: tableName, Item: { pk, sk, doc } })); },
    async deleteDoc(pk, sk) { await db.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } })); },
    async listDocs(pk) { return queryAll(pk); },
    /** 초대 코드를 한 번만 쓰게 한다. 이미 썼거나 기한이 지났으면 null. */
    async claimInvite(sk, now, uid) {
      try {
        const r = await db.send(new UpdateCommand({
          TableName: tableName, Key: { pk: 'INVITE', sk },
          UpdateExpression: 'SET #doc.usedAt = :now, #doc.uid = :uid',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#doc.usedAt) AND #doc.expiresAt > :now',
          ExpressionAttributeNames: { '#doc': 'doc' }, ExpressionAttributeValues: { ':now': now, ':uid': uid }, ReturnValues: 'ALL_NEW',
        }));
        return r.Attributes.doc;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return null;
        throw e;
      }
    },
  };
}

/**
 * 접속 기록 저장소. 학습 데이터와 쓰기 용량을 나눠 쓰지 않도록 테이블을 따로 둔다.
 *   pk = "IP", sk = IP 주소   행 하나에 그 IP의 처음·마지막 접속, 종류별 횟수, 마지막 User-Agent
 * expiresAt(초)이 지나면 DynamoDB TTL 이 행을 지운다.
 * 재시도를 하지 않는다(maxAttempts 1). 기록이 막혀도 앱 응답이 늦어지지 않게 하기 위해서다.
 */
export function createDynamoTraffic({ tableName, client, retentionDays = 90 }) {
  const base = client || new DynamoDBClient({ maxAttempts: 1 });
  const db = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  return {
    async recordVisit({ ip, kind, ua, path, who, now }) {
      const sets = ['firstSeen = if_not_exists(firstSeen, :now)', 'lastSeen = :now', 'expiresAt = :exp', 'ua = :ua'];
      const values = { ':now': now, ':exp': Math.floor(now / 1000) + retentionDays * 86400, ':ua': ua || '', ':one': 1 };
      if (kind === 'app' || kind === 'mcp') sets.push(`firstKey_${kind} = if_not_exists(firstKey_${kind}, :now)`);
      if (path) { sets.push('lastPath = :p'); values[':p'] = path; }
      if (who) { sets.push('who = :who'); values[':who'] = who; }
      await db.send(new UpdateCommand({
        TableName: tableName, Key: { pk: 'IP', sk: ip },
        UpdateExpression: 'SET ' + sets.join(', ') + ' ADD #n :one',
        ExpressionAttributeNames: { '#n': 'n_' + kind }, ExpressionAttributeValues: values,
      }));
    },
    /** 최근에 접속한 순서로 돌려준다. 혼자 쓰는 앱이라 행 수가 적다고 보고 전부 읽은 뒤 정렬한다. */
    async listVisits(limit = 300) {
      const rows = [];
      let ExclusiveStartKey;
      do {
        const r = await db.send(new QueryCommand({
          TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'IP' }, ExclusiveStartKey,
        }));
        rows.push(...(r.Items || []));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && rows.length < 5000);
      return rows.map(({ pk, sk, expiresAt, ...rest }) => ({ ip: sk, ...rest }))
        .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
    },
  };
}
