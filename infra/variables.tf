variable "region" {
  description = "리소스를 만들 AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "name" {
  description = "리소스 이름의 앞머리. 테이블, 함수, 역할 이름에 쓴다"
  type        = string
  default     = "rewind"
}

variable "domain_name" {
  description = "앱 주소로 쓸 도메인 (예: rewind.example.com). 비워 두면 도메인 없이 API Gateway 기본 주소를 쓴다"
  type        = string
  default     = ""
}

variable "zone_name" {
  description = "domain_name 이 속한 Route 53 호스팅 영역 이름 (예: example.com). domain_name 을 쓸 때만 필요하다"
  type        = string
  default     = ""

  validation {
    condition     = var.zone_name == "" || !endswith(var.zone_name, ".")
    error_message = "zone_name 은 끝의 점 없이 적는다 (example.com)."
  }
}

variable "log_retention_days" {
  description = "Lambda 로그 보관 기간(일)"
  type        = number
  default     = 14
}
