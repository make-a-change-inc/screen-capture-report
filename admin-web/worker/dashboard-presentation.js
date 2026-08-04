import { dashboardPage } from "./dashboard-page.js";

const replace = (page, before, after) => {
  if (!page.includes(before)) throw new Error(`dashboard presentation target missing: ${before}`);
  return page.replace(before, after);
};

let page = dashboardPage;

page = replace(page, "grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:24px}", "grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:24px}");
page = replace(page, ".metric strong{display:block;font-size:30px;margin-top:6px}.meta", ".metric strong{display:block;font-size:30px;margin-top:6px}.metric small{display:block;color:var(--muted);font-size:11px;margin-top:5px}.metric.primary small{color:#b9c2d2}.meta");
page = replace(page, ".proposal.primary{background:var(--blue-soft)}", ".proposal.primary{background:var(--blue-soft);color:var(--ink)}.proposal.primary h3,.proposal.primary .proposal-saving{color:var(--ink)}.proposal.primary .proposal-saving small{color:var(--muted)}");
page = replace(page, ".trend{display:flex;align-items:end;gap:10px;height:180px;padding-top:16px}", ".trend{display:flex;align-items:end;gap:10px;height:180px;padding-top:16px}.trend.trend-empty{display:block;height:auto;padding-top:0;margin:8px 0 0;color:var(--muted)}.view[data-page=\"opportunities\"] .cards+.panel{margin-top:20px}");
page = replace(page, ".warning{border-left-color:#d18a15;background:#fff8e9}", ".warning{border-left:0;background:#fff8e9}");
page = replace(page, ".meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}", ".meta{display:none}");
page = replace(page, "border-top:4px solid var(--blue);", "");
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

page = page.replace(
  /<section class="panel" style="margin-top:18px"><h2>.*?<\/h2><div class="trend" id="dashboardTrend"><\/div><\/section>/,
  '<section class="panel" style="margin-top:18px"><h2>直近3か月の週次実測推移</h2><div class="trend" id="dashboardTrend"></div></section>',
);

const previousProposal = /function proposalHtml\(item,index\)\{.*?\}\nfunction empty/;
if (!previousProposal.test(page)) throw new Error("dashboard proposal renderer missing");
page = page.replace(previousProposal, "function proposalHtml(item,index){return'<article class=\"proposal '+(index===0?'primary':'')+'\"><div class=\"proposal-rank\">'+(index+1)+'位　AI化候補</div><h3>'+esc(cat(item.category))+'</h3><div class=\"dept\">'+esc(item.department)+'・対象 '+item.people+'人</div><div class=\"proposal-saving\">−'+hours(item.saving)+'<small>／週・人（試算）</small></div><div class=\"proposal-ai\">'+esc(item.ai)+'</div><div class=\"proposal-note\">実測 '+hours(item.perPersonMinutes)+'／週・人 × 想定自動化率 '+pct(item.rate)+'<br>'+esc(item.note)+'</div></article>'}\nfunction empty");

const previousAlerts = /;const missing=source\.quality\.reportsWithoutCategoryData.*?\nfunction renderTrend/;
if (!previousAlerts.test(page)) throw new Error("dashboard alerts renderer missing");
page = page.replace(previousAlerts, "}\nfunction renderTrend");
page = replace(page, "hours=m=>Number(m)>0&&Number(m)<6?'<0.1h':(Number(m||0)/60).toFixed(1)+'h'", "hours=m=>(Number(m||0)/60).toFixed(Number(m)>0&&Number(m)<6?2:1)+'h'");

const previousTrend = /function renderTrend\(\)\{.*?\nfunction bars/;
if (!previousTrend.test(page)) throw new Error("dashboard trend renderer missing");
page = page.replace(previousTrend, `function renderTrend(){
  const trendWeeks=weeks().slice(0,12);
  if(trendWeeks.length<2){
    q('#dashboardTrend').classList.add('trend-empty');
    q('#dashboardTrend').textContent='2週分のデータがそろうと、週ごとの実測時間の変化を表示します';
    return;
  }
  q('#dashboardTrend').classList.remove('trend-empty');
  const totals=trendWeeks.reverse().map(w=>({label:w.start.slice(5),value:(source.rows||[]).filter(r=>matches(r,w.start+'|'+w.end,q('#department').value)&&!excluded(r.category)).reduce((s,r)=>s+Number(r.minutes),0)})),max=Math.max(1,...totals.map(x=>x.value));
  q('#dashboardTrend').innerHTML=totals.map(x=>'<div class="trend-item"><div class="trend-bar" style="height:'+Math.max(3,x.value/max*145)+'px" title="'+hours(x.value)+'"></div>'+esc(x.label)+'</div>').join('');
}
function bars`);

export const authenticatedDashboardPage = page;
