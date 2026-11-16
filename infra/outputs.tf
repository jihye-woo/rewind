output "base_url" {
  description = "앱이 떠 있는 주소"
  value       = local.base_url
}

# 아래 두 값에는 접속 키가 들어 있다. 보려면: terraform output -raw app_url
output "app_url" {
  description = "앱을 처음 열 때 쓰는 주소. 열면 키가 브라우저에 저장되고 주소에서는 지워진다"
  value       = "${local.base_url}/#key=${local.app_key}"
  sensitive   = true
}

output "mcp_url" {
  description = "ChatGPT 에 등록할 MCP 서버 주소"
  value       = "${local.base_url}/mcp/${random_password.mcp_key.result}"
  sensitive   = true
}

output "table_name" {
  description = "DynamoDB 테이블 이름"
  value       = aws_dynamodb_table.this.name
}
