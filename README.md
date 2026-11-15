# Rewind 영어 복습

미드나 검색에서 건진 영어 단어·표현을 GPT 대화에서 바로 등록하고, 하루 5분 세션으로 반복해서 익히는 1인용 앱입니다.

- **앱 화면**: 폰과 PC 브라우저에서 같은 주소로 엽니다. 폰에서는 홈 화면에 추가해 앱처럼 씁니다.
- **등록**: ChatGPT가 MCP 도구 `add_items`로 넣거나, GPT가 출력한 JSON을 앱의 등록 화면에 붙여 넣습니다.
- **서버**: AWS Lambda 하나가 앱 화면, 앱 API, MCP 엔드포인트를 모두 제공하고, 데이터는 DynamoDB에 둡니다.

```
브라우저(앱 화면) ─┐
                   ├─ https://<도메인> ─ API Gateway ─ Lambda(Node.js) ─ DynamoDB
ChatGPT(MCP) ──────┘
```

## 폴더

| 경로 | 내용 |
| --- | --- |
| `shared/core.js` | 등록 형식 검사·병합, 간격 계산, 세션 구성. 서버와 화면이 같은 파일을 씁니다 |
| `server/` | `handler.mjs`(Lambda 진입점), `http.mjs`(경로 처리), `mcp.mjs`(MCP 도구), `service.mjs`(등록·조회 로직), `store-dynamo.mjs`·`store-memory.mjs`(저장소) |
| `web/` | 앱 화면. `app.js`, `style.css`, `index.html`, 아이콘, 설치용 매니페스트 |
| `scripts/build.mjs` | 화면과 서버를 각각 한 파일로 묶어 `dist/`에 만듭니다 |
| `infra/` | Terraform. Lambda, DynamoDB, API Gateway, 인증서, Route 53 레코드 |
| `test/` | 자동 테스트 |

## 준비물

- Node.js 20 이상 (`node -v`로 확인)
- Terraform 1.5 이상
- AWS CLI 자격 증명 (`aws sts get-caller-identity`가 되는 상태)
- Route 53에 호스팅 영역이 있는 도메인

## 로컬에서 실행

AWS 없이 메모리 저장소로 전체를 띄웁니다. 서버를 끄면 데이터는 사라집니다.

```bash
npm install
npm run dev
# 앱:  http://localhost:8787/#key=dev-app-key
# MCP: http://localhost:8787/mcp/dev-mcp-key
```

테스트는 `npm test`입니다. 공용 로직, API, MCP(공식 MCP 클라이언트로 접속), DynamoDB 저장소(로컬 흉내 서버 사용), 배포될 Lambda 묶음까지 확인합니다.

## 배포

```bash
# 1) 빌드: dist/lambda/index.mjs 가 만들어집니다
npm install
npm run build

# 2) 도메인 설정
cd infra
cp terraform.tfvars.example terraform.tfvars
#    terraform.tfvars 를 열어 domain_name 과 zone_name 을 내 도메인으로 바꿉니다

# 3) 배포. 인증서 발급과 DNS 확인 때문에 처음에는 몇 분 걸립니다
terraform init
terraform apply

# 4) 주소 확인. 두 값에는 접속 키가 들어 있습니다
terraform output -raw app_url    # 앱을 처음 열 주소
terraform output -raw mcp_url    # ChatGPT 에 등록할 주소
```

`app_url`을 브라우저에서 열면 접속 키가 그 브라우저에 저장되고 주소에서는 지워집니다. 다음부터는 `https://<도메인>`만 열면 됩니다.

코드를 고친 뒤에는 `npm run build`와 `terraform apply`를 다시 실행합니다.

### 만들어지는 것

| 리소스 | 설정 | 이유 |
| --- | --- | --- |
| DynamoDB 테이블 | 프로비저닝 모드, 읽기·쓰기 5유닛, 삭제 보호 | 프로비저닝 모드여야 상시 무료 한도가 적용됩니다 |
| Lambda | Node.js 22, arm64, 256MB, 제한 시간 10초 | 화면·API·MCP를 한 함수가 처리합니다 |
| API Gateway (HTTP API) | 모든 경로를 Lambda로, 초당 10건 제한 | 도메인을 붙이려면 Lambda 앞에 필요합니다. 요청 제한은 주소가 알려졌을 때의 비용 상한입니다 |
| ACM 인증서, Route 53 레코드 | DNS 확인 방식 | `domain_name`을 비워 두면 만들지 않고 API Gateway 기본 주소를 씁니다 |
| 접속 키 2개 | 앱용, MCP용 | MCP 주소가 새도 앱 API(조회·삭제)는 쓸 수 없습니다 |

비용은 Lambda와 DynamoDB가 상시 무료 한도 안이고, API Gateway는 요청 100만 건당 1달러 안팎이라 혼자 쓰는 양으로는 월 몇 원 수준입니다. Route 53 호스팅 영역 요금은 이미 내고 계신 그대로입니다. 금액은 배포 전에 AWS 요금 페이지에서 한 번 확인하세요.

## ChatGPT에 연결

1. ChatGPT 웹에서 사용자 정의 MCP 서버(커넥터) 추가 화면을 엽니다. 메뉴 위치는 자주 바뀝니다. Plugins 화면의 "Add custom MCP server", 또는 설정의 Connectors에서 찾습니다.
2. 서버 주소에 `terraform output -raw mcp_url` 값을 넣고, 인증은 "없음"을 고릅니다. 주소 안의 키가 인증 역할을 합니다.
3. 대화에서 표현을 물어본 뒤 "등록해 줘"라고 합니다. ChatGPT가 `add_items` 호출을 승인할지 물으면 승인합니다.

확인할 것이 하나 있습니다. Plus·Pro 개인 요금제에서 쓰기 도구가 동작하는지는 안내가 엇갈립니다. `add_items`가 호출되지 않으면 `find_items`(읽기 전용)만 쓰고, 등록은 아래 붙여넣기로 합니다.

**붙여넣기 등록**: 앱의 등록 화면 아래에 있는 "붙여넣기용 GPT 지시문"을 ChatGPT 맞춤 지침에 넣어 둡니다. "등록"이라고 하면 GPT가 JSON을 출력하고, 그것을 등록 화면에 붙여 넣어 체크한 항목만 저장합니다. 폰에서도 됩니다.

### 무엇이 등록되는가

| 상황 | `picked_by` | 앱에서의 상태 |
| --- | --- | --- |
| 사용자가 표현을 짚었거나, 후보 목록에서 고름 | `user` | 대기. 세션에 들어갑니다 |
| GPT가 알아서 고름, 또는 표시 없음 | `assistant` 또는 없음 | 후보. 꺼진 채 들어오고, 앱에서 "학습에 넣기"를 눌러야 세션에 나옵니다 |

MCP 도구는 `add_items`와 `find_items` 둘뿐입니다. 수정·삭제 도구는 없습니다. 삭제와 켜기·끄기는 앱의 항목 화면에서만 합니다.

## 폰에 설치

- iPhone: Safari로 `app_url`을 연 뒤 공유 → "홈 화면에 추가". 홈 화면 앱은 Safari와 저장소가 따로라서 처음 한 번 접속 키를 물어봅니다. `app_url`에서 `#key=` 뒤의 값을 붙여 넣습니다.
- Android: Chrome으로 연 뒤 메뉴 → "홈 화면에 추가" 또는 "앱 설치".

## 데이터

- 기록 화면 아래의 "전체 기록 백업 받기"로 항목과 세션 로그를 JSON으로 받습니다.
- Terraform 상태 파일(`infra/terraform.tfstate`)에는 접속 키가 들어 있습니다. `.gitignore`에 넣어 두었으니 저장소에 올리지 마세요. 여러 컴퓨터에서 배포하려면 S3 백엔드로 옮기면 됩니다.
- 키를 바꾸려면 `terraform apply -replace=random_password.mcp_key`(또는 `app_key`)를 실행합니다. 앱 키를 바꾸면 각 기기에서 새 `app_url`로 한 번 다시 엽니다.
- 테이블에는 삭제 보호가 걸려 있습니다. `terraform destroy`를 하려면 `main.tf`의 `deletion_protection_enabled`를 `false`로 바꿔 먼저 apply합니다.

## Node.js가 처음이라면

| Java에서 | 여기서는 |
| --- | --- |
| `build.gradle`, `pom.xml` | `package.json`. 의존성과 실행 명령(`scripts`)이 들어 있습니다 |
| `./gradlew build` | `npm install`(의존성 받기) 후 `npm run build` |
| `./gradlew test` | `npm test`. 테스트 러너는 Node.js에 내장된 `node:test`입니다 |
| jar로 묶기 | `scripts/build.mjs`가 esbuild로 서버 코드를 `dist/lambda/index.mjs` 한 파일로 묶습니다 |
| 인터페이스와 구현체 | `store-memory.mjs`와 `store-dynamo.mjs`가 같은 메서드를 가진 객체를 돌려줍니다. 타입 선언은 없고 모양만 맞춥니다 |
| `.java` | `.mjs`와 `.js`. 이 저장소는 모두 ES 모듈(`import`/`export`)입니다 |

읽는 순서는 `server/http.mjs`(어떤 경로가 있는지) → `server/service.mjs`(각 경로가 하는 일) → `shared/core.js`(등록 규칙과 세션 규칙)를 권합니다.

## 학습 규칙 요약

- 세션 1회에 항목 7개. 최근 넣은 항목이 있으면 10개까지, 카드는 다시 풀기를 빼고 16장까지.
- 등록한 지 7일 이내인 항목은 복습 시점과 무관하게 매 세션에 나옵니다.
- 표현은 보고 익히기 2번에 퀴즈 1번, 단어는 보고 익히기 1번에 퀴즈 1~2번.
- 항목마다 기억 반감기를 두고, 예상 기억 확률이 0.7 아래로 내려가면 복습 대상이 됩니다. 맞히면 최대 2배, 틀리면 절반.
- 숫자는 `shared/core.js` 맨 위의 `CFG`에 모여 있습니다.
