/**
 * Lambda 진입점. API Gateway(HTTP API, payload 2.0)가 보내는 이벤트를 라우터가 읽는 모양으로 바꾼다.
 * 환경 변수: TABLE_NAME, APP_KEY, MCP_KEY, PUBLIC_READ (Terraform이 넣어 준다)
 */
import { route } from './http.mjs';
import { createDynamoStore } from './store-dynamo.mjs';
import { assets } from '../dist/web-assets.mjs';

const store = createDynamoStore({ tableName: process.env.TABLE_NAME });
const config = { appKey: process.env.APP_KEY, mcpKey: process.env.MCP_KEY, publicRead: process.env.PUBLIC_READ === 'true' };

export async function handler(event) {
  const body = event.body == null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const res = await route({
    method: event.requestContext?.http?.method || 'GET',
    path: event.rawPath || '/',
    headers: event.headers || {}, // HTTP API는 헤더 이름을 소문자로 준다
    body,
  }, { store, config, assets });
  return { statusCode: res.status, headers: res.headers, body: res.body || '', isBase64Encoded: !!res.base64 };
}
