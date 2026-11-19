#!/usr/bin/env bash
# CloudFront が、この検証の VPC に作ったグループ（CloudFront-VPCOrigins-Service-SG）の ID を出す。なければ空を出す。
# グループは、VPC に最初の VPC origin を作ったときに CloudFront が作り、AWS が管理する（書き換えない）。
set -euo pipefail
REGION=${AWS_REGION:-ap-northeast-1}
VPC=$(aws cloudformation describe-stacks --region "$REGION" --stack-name gekko13-network \
  --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text 2>/dev/null || true)
[ -n "$VPC" ] && [ "$VPC" != None ] || exit 0
SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC" Name=group-name,Values=CloudFront-VPCOrigins-Service-SG \
  --query 'SecurityGroups[0].GroupId' --output text)
[ "$SG" = None ] || echo "$SG"
