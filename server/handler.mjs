/**
 * Lambda 진입점. API Gateway(HTTP API, payload 2.0)가 보내는 이벤트를 라우터가 읽는 모양으로 바꾼다.
 * 환경 변수: TABLE_NAME, TRAFFIC_TABLE_NAME, APP_KEY, MCP_KEY, PUBLIC_READ, BASE_PATH (Terraform이 넣어 준다)
 *
 * BASE_PATH(예: /english)는 도메인 아래 이 서비스의 경로다. API Gateway 의 API 매핑이 경로를 떼어 주는지와
 * 관계없이 동작하도록, 경로가 BASE_PATH 로 시작하면 여기서 떼어 낸다.
 */
import { route } from './http.mjs';
import { createDynamoStore, createDynamoTraffic } from './store-dynamo.mjs';
import { assets } from '../dist/web-assets.mjs';

const store = createDynamoStore({ tableName: process.env.TABLE_NAME });
const traffic = process.env.TRAFFIC_TABLE_NAME ? createDynamoTraffic({ tableName: process.env.TRAFFIC_TABLE_NAME }) : undefined;
const basePath = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const config = { appKey: process.env.APP_KEY, mcpKey: process.env.MCP_KEY, publicRead: process.env.PUBLIC_READ === 'true', basePath };

export async function handler(event) {
  let path = event.rawPath || '/';
  if (basePath && path === basePath) {
    // /english → /english/ : 화면 안의 상대 경로가 서비스 경로 아래를 가리키게 한다
    return { statusCode: 308, headers: { location: basePath + '/' + (event.rawQueryString ? '?' + event.rawQueryString : '') }, body: '' };
  }
  if (basePath && path.startsWith(basePath + '/')) path = path.slice(basePath.length);
  const body = event.body == null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const res = await route({
    method: event.requestContext?.http?.method || 'GET',
    path,
    headers: event.headers || {}, // HTTP API는 헤더 이름을 소문자로 준다
    body,
    ip: event.requestContext?.http?.sourceIp,
  }, { store, traffic, config, assets });
  return { statusCode: res.status, headers: res.headers, body: res.body || '', isBase64Encoded: !!res.base64 };
}
