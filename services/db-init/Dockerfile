# SPIRE server のタスクで、server より先に動いて終わるコンテナ（段 D の D1-a1）。Aurora にサービスごとのデータベースとロールを作り、
# Aurora の CA と SPIRE の根の CA を、タスクの中のボリュームに書く（init.sh）。psql を使うので、PostgreSQL の公式のイメージを元にする。
# RUN を使わないので、arm64 のイメージもエミュレーションなしで作れる。
FROM postgres:17.5-alpine
COPY --chmod=0755 init.sh /init.sh
COPY --chmod=0644 db-init.sql /db-init.sql
ENTRYPOINT ["/init.sh"]
