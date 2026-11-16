# Rewind 영어 복습 앱
#
#   브라우저 / ChatGPT
#        │  https://<domain_name>
#        ▼
#   API Gateway (HTTP API)  ──►  Lambda (Node.js)  ──►  DynamoDB
#
# Lambda 하나가 앱 화면, 앱 API(/api/*), MCP 엔드포인트(/mcp/<키>)를 모두 제공한다.

locals {
  use_domain = var.domain_name != ""
  base_path  = local.use_domain && var.base_path != "" ? "/${var.base_path}" : ""
  base_url   = local.use_domain ? "https://${var.domain_name}${local.base_path}" : aws_apigatewayv2_api.this.api_endpoint
  # 직접 정한 키가 있으면 그것을, 없으면 무작위 키를 쓴다
  app_key = var.app_key != "" ? var.app_key : random_password.app_key.result
}

# ---------------------------------------------------------------------------
# 접속 키. 앱용과 MCP용을 따로 둔다: MCP 주소가 새도 앱 API(조회·삭제)는 쓸 수 없다.
# 앱 키는 var.app_key 로 직접 정할 수 있다. 정하지 않으면 아래 무작위 키를 쓴다.
# 키를 바꾸려면: terraform apply -replace=random_password.mcp_key
# ---------------------------------------------------------------------------
resource "random_password" "app_key" {
  length  = 40
  special = false
}

resource "random_password" "mcp_key" {
  length  = 40
  special = false
}

# ---------------------------------------------------------------------------
# DynamoDB: 테이블 하나. pk="ITEM"|"SESSION", sk=ID
# 프로비저닝 모드여야 상시 무료 한도(읽기·쓰기 25유닛)가 적용된다.
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "this" {
  name           = var.name
  billing_mode   = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # 학습 기록이 들어 있으므로 실수로 지우지 못하게 한다.
  # terraform destroy 를 하려면 먼저 false 로 바꿔 apply 한다.
  deletion_protection_enabled = true
}

# 접속 기록(IP별). 요청마다 한 번 쓰므로 학습 데이터 테이블과 쓰기 용량을 나눠 쓰지 않게 따로 둔다.
# 두 테이블을 합쳐도 상시 무료 한도(읽기·쓰기 25유닛) 안이다. 행은 마지막 접속 후 90일이 지나면 TTL 로 지워진다.
resource "aws_dynamodb_table" "traffic" {
  name           = "${var.name}-traffic"
  billing_mode   = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist/lambda" # npm run build 가 만든다
  output_path = "${path.module}/build/lambda.zip"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.this.arn]
  }

  statement {
    sid       = "Traffic"
    actions   = ["dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.traffic.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  function_name    = var.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.this.name
      TRAFFIC_TABLE_NAME = aws_dynamodb_table.traffic.name
      APP_KEY            = local.app_key
      MCP_KEY            = random_password.mcp_key.result
      PUBLIC_READ        = tostring(var.public_read)
      BASE_PATH          = local.base_path
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda]
}

# ---------------------------------------------------------------------------
# API Gateway (HTTP API): 모든 경로를 Lambda 로 넘긴다
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"

  # 도메인을 쓰면 기본 주소(execute-api)로는 접속하지 못하게 한다
  disable_execute_api_endpoint = local.use_domain
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  # 혼자 쓰는 앱이라 낮게 잡는다. 주소가 알려져 요청이 몰려도 비용이 늘지 않게 하는 상한이다.
  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# 도메인: 인증서(ACM) 발급 → DNS 로 소유 확인 → API Gateway 에 연결 → Route 53 레코드
# domain_name 이 비어 있으면 이 아래는 만들지 않는다.
# ---------------------------------------------------------------------------
data "aws_route53_zone" "this" {
  count        = local.use_domain ? 1 : 0
  name         = var.zone_name
  private_zone = false
}

resource "aws_acm_certificate" "this" {
  count             = local.use_domain ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_domain ? {
    for o in aws_acm_certificate.this[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  zone_id         = data.aws_route53_zone.this[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count                   = local.use_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_apigatewayv2_domain_name" "this" {
  count       = local.use_domain ? 1 : 0
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.this[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  count       = local.use_domain ? 1 : 0
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this[0].id
  stage       = aws_apigatewayv2_stage.default.id

  # 이 경로로 오는 요청만 이 API 로 보낸다. 같은 도메인의 다른 경로에는 다른 서비스의 API 를 매핑할 수 있다.
  # 루트(https://<도메인>/)에는 아무것도 매핑하지 않는다.
  api_mapping_key = var.base_path != "" ? var.base_path : null
}

resource "aws_route53_record" "app" {
  count   = local.use_domain ? 1 : 0
  zone_id = data.aws_route53_zone.this[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.this[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
