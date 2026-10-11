import { api, root, esc, on, status, reauthenticate } from "./api.js";
export async function operationsPage() {
  const [backups, audit] = await Promise.all([api("/backups"), api("/audit")]);
  root.innerHTML = `<h1>备份与操作记录</h1><section class="card"><h2>内容与媒体备份</h2><p>备份包含博客内容与上传媒体，使用密钥加密。管理员密码和会话不进入备份。恢复只能通过运维命令写入独立空数据库。</p><button data-backup>创建加密备份</button><div>${backups.map((b) => `<p>${esc(b.id)} · ${(b.byteSize / 1048576).toFixed(2)} MiB · ${esc(b.createdAt)}</p>`).join("") || '<p class="muted">还没有备份。</p>'}</div></section><section class="card"><h2>最近操作</h2><table><thead><tr><th>操作</th><th>内容标识</th><th>时间</th></tr></thead><tbody>${audit.map((x) => `<tr><td>${esc(x.action)}</td><td>${x.targetId || ""}</td><td>${esc(new Date(x.createdAt).toLocaleString())}</td></tr>`).join("")}</tbody></table></section>`;
  on("[data-backup]", "click", async () => {
    if (!(await reauthenticate())) return;
    status("正在创建备份，请稍候…");
    await api("/maintenance/backup", { method: "POST", key: true });
    await operationsPage();
    status("加密备份已创建。");
  });
}
