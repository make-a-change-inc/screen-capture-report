import { dashboardPage } from "./dashboard-page.js";

const replace = (page, before, after) => {
  if (!page.includes(before)) throw new Error(`dashboard presentation target missing: ${before}`);
  return page.replace(before, after);
};

let page = dashboardPage;

page = replace(page, "grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:24px}", "grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:24px}");
page = replace(page, ".metric strong{display:block;font-size:30px;margin-top:6px}.meta", ".metric strong{display:block;font-size:30px;margin-top:6px}.metric small{display:block;color:var(--muted);font-size:11px;margin-top:5px}.metric.primary small{color:#b9c2d2}.meta");
page = page.replaceAll("経営ダッシュボード", "経営サマリー");
page = replace(page, "確定済み週次管理レポートの実測値を集計しています。", "選択中の週・部署の実測データをもとに、効果が見込める業務を提案します。");
page = replace(page, "<div class=\"eyebrow\">経営判断</div>", "<div class=\"eyebrow\">AI化提案</div>");
page = replace(page, "<div class=\"eyebrow\">AI化トランスフォーメーション</div>", "<div class=\"eyebrow\">AI TRANSFORMATION</div>");
page = replace(page, "削減見込みは実測時間にカテゴリ別の暫定係数を掛けた試算です。", "削減見込みは、1人あたりの週次実測時間に業務カテゴリごとの想定自動化率を掛けた試算です。");
page = replace(page, "<span>週次実測時間</span><strong id=\"totalHours\">—</strong>", "<span>対象業務の週次実測時間</span><strong id=\"totalHours\">—</strong><small>選択中の週・部署の合計</small>");
page = replace(page, "<span>週次削減見込み（試算）</span><strong id=\"savingHours\">—</strong>", "<span>AI化した場合の週次削減見込み</span><strong id=\"savingHours\">—</strong><small>選択中の範囲全体の試算</small>");
page = replace(page, "<div class=\"metric\"><span>同期済みレポート</span><strong id=\"reportCount\">—</strong></div>", "");
page = replace(page, "<span>対象従業員</span><strong id=\"employeeCount\">—</strong>", "<span>今回の集計対象社員数</span><strong id=\"employeeCount\">—</strong><small>実測データがある社員数</small>");
page = replace(page, "1人あたりの削減見込みが大きい順", "削減見込みが大きい順。数値はすべて1人あたり・1週間の試算です。");
page = replace(page, "q('#reportCount').textContent=reportCount;", "");
page = replace(page, "q('#scope').textContent='集計範囲 '+(q('#department').value||'全社')+'・'+(period?period.replace('|','〜'):'全期間');", "q('#scope').textContent='集計対象 '+(q('#department').value||'全社')+'・'+(period?period.replace('|','〜'):'対象週データなし');");
page = replace(page, '<div class="grid-2" style="margin-top:18px"><section class="panel"><h2>最大12週の実測推移</h2><div class="trend" id="dashboardTrend"></div></section><section class="panel"><h2>要対応事項</h2><div id="alerts"></div></section></div>', '<section class="panel" style="margin-top:18px"><h2>最大12週の実測推移</h2><div class="trend" id="dashboardTrend"></div></section>');

const previousProposal = /function proposalHtml\(item,index\)\{.*?\}\nfunction empty/;
if (!previousProposal.test(page)) throw new Error("dashboard proposal renderer missing");
page = page.replace(previousProposal, "function proposalHtml(item,index){return'<article class=\"proposal '+(index===0?'primary':'')+'\"><div class=\"proposal-rank\">'+(index+1)+'位　AI化候補</div><h3>'+esc(cat(item.category))+'</h3><div class=\"dept\">'+esc(item.department)+'・対象 '+item.people+'人</div><div class=\"proposal-saving\">−'+hours(item.saving)+'<small>／週・人（試算）</small></div><div class=\"proposal-ai\">'+esc(item.ai)+'</div><div class=\"proposal-note\">実測 '+hours(item.perPersonMinutes)+'／週・人 × 想定自動化率 '+pct(item.rate)+'<br>'+esc(item.note)+'</div></article>'}\nfunction empty");

const previousAlerts = /;const missing=source\.quality\.reportsWithoutCategoryData.*?\nfunction renderTrend/;
if (!previousAlerts.test(page)) throw new Error("dashboard alerts renderer missing");
page = page.replace(previousAlerts, "\nfunction renderTrend");

export const authenticatedDashboardPage = page;
