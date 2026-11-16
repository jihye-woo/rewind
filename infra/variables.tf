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

variable "app_key" {
  description = "앱 접속 키를 직접 정할 때 쓴다. 비워 두면 Terraform 이 40자 무작위 키를 만든다. tfvars 에 적거나 TF_VAR_app_key 환경 변수로 넘긴다"
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = var.app_key == "" || (length(var.app_key) >= 12 && can(regex("^[A-Za-z0-9._~-]+$", var.app_key)))
    error_message = "app_key 는 12자 이상이고 영문, 숫자, . _ ~ - 만 쓸 수 있다 (주소의 #key= 뒤에 그대로 들어가기 때문)."
  }
}

variable "public_read" {
  description = "true 면 접속 키 없이도 앱을 읽기 전용으로 볼 수 있다 (항목, 통계, 세션 기록). 등록, 학습, 끄기, 삭제, 백업은 키가 있어야 한다"
  type        = bool
  default     = true
}
