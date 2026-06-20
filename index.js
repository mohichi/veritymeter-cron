// veritymeter-cron Worker
// Cron Triggerで毎朝自動実行され、主要メディアの当日ニュースをAIで取得・信憑性診断し、
// 結果をKVストレージ（NEWS_KV）に保存する。
//
// KVのbinding名は "NEWS_KV"、環境変数は "ANTHROPIC_API_KEY" を使用する想定。

// 対象メディア一覧
// 注意：個別メディアのRSSやスクレイピングは行わず、AIのWeb検索機能を通じて
// 「公開されている検索結果」を要約させる方式を採る（著作権・利用規約への配慮）。
const MEDIA_LIST = [
  { id: "nhk", name: "NHKニュース", domain: "www3.nhk.or.jp" },
  { id: "kyodo", name: "共同通信", domain: "nordot.app" },
  { id: "asahi", name: "朝日新聞デジタル", domain: "asahi.com" },
  { id: "yomiuri", name: "読売新聞オンライン", domain: "yomiuri.co.jp" },
  { id: "nikkei", name: "日本経済新聞", domain: "nikkei.com" },
  { id: "toyokeizai", name: "東洋経済オンライン", domain: "toyokeizai.net" },
  { id: "reuters", name: "ロイター（日本語版）", domain: "jp.reuters.com" },
  { id: "bunshun", name: "週刊文春デジタル", domain: "bunshun.jp" },
  { id: "shincho", name: "デイリー新潮", domain: "dailyshincho.jp" },
];

async function fetchMediaNews(media, apiKey) {
  const systemPrompt = `あなたはニュース調査・信憑性診断の専門AIです。
Web検索を使って、「${media.name}」（ドメイン: ${media.domain}）が本日掲載している主要記事を調査してください。

手順：
1. "${media.domain}" のサイトで本日報じられている主要なニュース記事を、検索を使って最大10件見つける
2. 見つかった各記事について、タイトル・URL・簡潔な要約・信憑性スコアを判定する
3. 必ずJSON形式のみで返答する（前置き・説明・マークダウン不要）

JSON形式：
{
  "articles": [
    {
      "title": "記事タイトル",
      "url": "記事の実際のURL",
      "excerpt": "記事内容の1文要約（30文字程度）",
      "score": 数値(0-100、記事内容の信憑性スコア),
      "comment": "簡潔な総評（1文、40文字程度）"
    }
  ]
}

スコア基準：
- 80-100：根拠が明確、一次情報や事実報道が中心
- 60-79：概ね妥当
- 40-59：事実と意見・憶測が混在
- 20-39：根拠が薄い、誇張・扇情的な見出しが目立つ
- 0-19：信憑性に重大な問題

記事が見つからない、またはアクセスできない場合は {"articles": []} を返してください。
最大10件まで、実際に確認できた記事のみを含めてください。`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system: systemPrompt,
        messages: [
          { role: "user", content: `${media.name}（${media.domain}）の本日の主要記事を調査してください。` },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`API error for ${media.id}:`, errText);
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `API error (${apiRes.status}): ${errText.slice(0, 300)}` };
    }

    const data = await apiRes.json();
    const fullText = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const clean = fullText.replace(/```json|```/g, "").trim();

    const matches = clean.match(/\{[\s\S]*\}/g);
    const candidate = matches && matches.length ? matches[matches.length - 1] : clean;

    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (e) {
      console.error(`Parse error for ${media.id}:`, fullText.slice(0, 500));
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `JSON解析失敗: ${fullText.slice(0, 200)}` };
    }

    return {
      mediaId: media.id,
      mediaName: media.name,
      articles: (parsed.articles || []).slice(0, 10),
      error: false,
    };
  } catch (e) {
    console.error(`Fetch error for ${media.id}:`, e);
    return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: String(e) };
  }
}

async function runDailyUpdate(env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
  }
  if (!env.NEWS_KV) {
    return { ok: false, error: "NEWS_KV binding is not set" };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC基準）
  const results = [];

  // メディアを順番に処理（同時並行しすぎるとレート制限にかかりやすいため直列実行）
  for (const media of MEDIA_LIST) {
    const result = await fetchMediaNews(media, apiKey);
    results.push(result);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    date: today,
    media: results,
  };

  // 当日分として保存（トップページが読みに来る）
  await env.NEWS_KV.put("latest", JSON.stringify(payload));
  // 日付ごとのアーカイブとしても保存（将来の履歴機能用）
  await env.NEWS_KV.put(`archive:${today}`, JSON.stringify(payload));

  return {
    ok: true,
    date: today,
    mediaCount: results.length,
    totalArticles: results.reduce((sum, r) => sum + (r.articles ? r.articles.length : 0), 0),
    perMedia: results.map(r => ({ id: r.mediaId, articles: r.articles.length, error: r.error })),
  };
}

export default {
  // Cron Triggerから呼ばれるハンドラ
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyUpdate(env));
  },

  // 手動実行・動作確認用（ブラウザから直接アクセスして実行できる）
  // 本番運用では認証をかけることを推奨
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await runDailyUpdate(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      const data = await env.NEWS_KV.get("latest");
      return new Response(data || "No data yet", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("veritymeter-cron worker. Use /run or /status", { status: 200 });
  },
};
