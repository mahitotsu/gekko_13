# 事務サービス（Python、FastMCP）のイメージ（段 D の D1-a2-2）。RUN を使わない。
# 依存（site/）は scripts/stage-python.sh が、動かす側の CPU の wheel だけを取り込んで置く。文脈も scripts/stage-python.sh が作る。
FROM python:3.12-slim
WORKDIR /app
COPY site /app/site
COPY insurer_mcp /app/insurer_mcp
ENV PYTHONPATH=/app/site:/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000
CMD ["python", "-m", "insurer_mcp.main"]
