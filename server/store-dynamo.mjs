/**
 * DynamoDB 저장소. 테이블 하나에 두 종류의 행을 둔다.
 *   pk = "ITEM",    sk = 항목 ID        doc = 항목 전체
 *   pk = "SESSION", sk = 세션 ID(s+시작 시각)  doc = 세션 로그
 * 혼자 쓰는 앱이라 pk를 고정했다. 여러 사용자가 쓰게 되면 pk 앞에 사용자 ID를 붙이면 된다.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export function createDynamoStore({ tableName, client }) {
  const base = client || new DynamoDBClient({});
  const db = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });

  /** 한 pk의 행을 끝까지 읽는다. DynamoDB는 한 번에 1MB까지만 주므로 이어 읽는다. */
  async function queryAll(pk, { forward = true, limit = Infinity } = {}) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: forward, ExclusiveStartKey, ...(Number.isFinite(limit) ? { Limit: limit - out.length } : {}),
      }));
      for (const row of r.Items || []) out.push(row.doc);
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
    async listSessions(limit = 120) { return queryAll('SESSION', { forward: false, limit }); },
    async putSession(id, doc) {
      await db.send(new PutCommand({ TableName: tableName, Item: { pk: 'SESSION', sk: id, doc: { id, ...doc } } }));
    },
  };
}
