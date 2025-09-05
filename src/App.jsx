import React, { useMemo, useState } from "react";

// --- URLs ---
const DOUBLES_URL = "https://r.jina.ai/http://www.pickleball.ky/rankings/";
const SINGLES_URL = "https://r.jina.ai/http://www.pickleball.ky/singles-rankings/";

// --- Utilities ---
function stripDiacritics(str) {
  return str.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeName(raw) {
  if (!raw) return "";
  let s = stripDiacritics(raw)
    .toLowerCase()
    .replace(/[\.,'’\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = s.split(" ").filter((t) => t.length > 1);
  return tokens.join(" ");
}

// --- Fuzzy matching helpers ---
function levenshtein(a, b) {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const v0 = new Array(bn + 1).fill(0);
  const v1 = new Array(bn + 1).fill(0);
  for (let i = 0; i <= bn; i++) v0[i] = i;
  for (let i = 0; i < an; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bn; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= bn; j++) v0[j] = v1[j];
  }
  return v1[bn];
}

function ratio(a, b) {
  if (!a && !b) return 100;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return Math.round((1 - dist / maxLen) * 100);
}

function tokenSetRatio(a, b) {
  const A = Array.from(new Set(a.split(" ").filter(Boolean))).sort();
  const B = Array.from(new Set(b.split(" ").filter(Boolean))).sort();
  const common = A.filter((t) => B.includes(t)).join(" ");
  return Math.max(
    ratio(common, a),
    ratio(common, b),
    ratio(A.join(" "), B.join(" "))
  );
}

// --- Parsing rankings ---
function parseRankingsFromHtml(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  if (!tables.length) throw new Error("NO_TABLE");

  const target = tables.find((t) => t.querySelector("tbody tr")) || tables[0];
  const rows = Array.from(target.querySelectorAll("tbody tr, tr"));
  if (!rows.length) throw new Error("NO_ROWS");

  let items = [];
  for (const tr of rows) {
    const cells = Array.from(tr.querySelectorAll("td,th"));
    if (cells.length < 2) continue;
    const name = (cells[0]?.textContent || "").trim();
    const ratingRaw = (cells[cells.length - 1]?.textContent || "").trim();
    const rating = parseFloat(ratingRaw.replace(/[^0-9.]/g, ""));
    if (!name) continue;
    if (!Number.isFinite(rating)) continue;
    items.push({ name, rating });
  }

  if (!items.length) throw new Error("BAD_SHAPE");

  const byNorm = new Map();
  for (const it of items) {
    const key = normalizeName(it.name);
    const old = byNorm.get(key);
    if (!old || it.rating > old.rating) byNorm.set(key, it);
  }
  return Array.from(byNorm.values());
}

function parseRankingsFromMarkdown(markdownText) {
  const lines = markdownText.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    if (/\|.*\|/.test(line) && /\|\s*-{3,}/.test(next)) {
      const block = [line, next];
      let j = i + 2;
      while (j < lines.length && /\|.*\|/.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      tables.push(block.join("\n"));
      i = j;
    }
  }
  if (!tables.length) throw new Error("NO_TABLE");

  for (const tbl of tables) {
    const rows = tbl.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length < 3) continue;
    const header = rows[0].split("|").map((s) => s.trim().toLowerCase());
    let nameIdx = header.findIndex((t) => /name|player/.test(t));
    let ratingIdx = header.findIndex((t) => /rating|doubles|singles|cirp/.test(t));

    const dataRows = rows.slice(2).map((r) => r.split("|").map((s) => s.trim()));

    if (nameIdx < 0 || ratingIdx < 0) {
      const colCount = Math.max(...dataRows.map((r) => r.length));
      const numericCounts = new Array(colCount).fill(0);
      for (const r of dataRows) {
        for (let c = 0; c < colCount; c++) {
          const val = (r[c] || "").replace(/[^0-9.]/g, "");
          if (val && !isNaN(parseFloat(val))) numericCounts[c]++;
        }
      }
      if (ratingIdx < 0) ratingIdx = numericCounts.indexOf(Math.max(...numericCounts));
      if (nameIdx < 0) {
        let min = Infinity,
          minIdx = 0;
        for (let i = 0; i < numericCounts.length; i++) {
          if (numericCounts[i] < min) {
            min = numericCounts[i];
            minIdx = i;
          }
        }
        nameIdx = minIdx;
      }
    }

    const items = [];
    for (const r of dataRows) {
      const name = (r[nameIdx] || "").trim();
      const ratingRaw = (r[ratingIdx] || "").trim();
      const rating = parseFloat(ratingRaw.replace(/[^0-9.]/g, ""));
      if (!name) continue;
      if (!Number.isFinite(rating)) continue;
      items.push({ name, rating });
    }
    if (items.length) {
      const byNorm = new Map();
      for (const it of items) {
        const key = normalizeName(it.name);
        const old = byNorm.get(key);
        if (!old || it.rating > old.rating) byNorm.set(key, it);
      }
      return Array.from(byNorm.values());
    }
  }
  throw new Error("BAD_SHAPE");
}

async function fetchRankings(mode) {
  const url = mode === "singles" ? SINGLES_URL : DOUBLES_URL;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("FETCH_FAIL");
  const text = await res.text();
  try {
    return parseRankingsFromHtml(text);
  } catch {
    return parseRankingsFromMarkdown(text);
  }
}

// --- Matching ---
function groupByLastName(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const norm = normalizeName(c.name);
    const last = norm.split(" ").pop() || "";
    if (!map.has(last)) map.set(last, []);
    map.get(last).push(c);
  }
  return map;
}

function applyMatching(inputs, rankings) {
  const byNorm = new Map(rankings.map((r) => [normalizeName(r.name), r]));
  const lastNameGroups = groupByLastName(rankings);

  const matched = [];
  const unmatched = [];

  for (const original of inputs) {
    const norm = normalizeName(original);
    let found = byNorm.get(norm) || null;

    if (!found) {
      let best = null;
      let bestScore = 0;
      for (const r of rankings) {
        const s = tokenSetRatio(norm, normalizeName(r.name));
        if (s > bestScore) {
          bestScore = s;
          best = r;
        }
      }
      if (best && bestScore >= 85) found = best;
    }

    if (!found) {
      const last = norm.split(" ").pop();
      const pool = lastNameGroups.get(last) || [];
      if (pool.length) found = pool.reduce((a, b) => (a.rating >= b.rating ? a : b));
    }

    if (!found) {
      let best = null;
      let bestScore = 0;
      for (const r of rankings) {
        const s = tokenSetRatio(norm, normalizeName(r.name));
        if (s > bestScore) {
          bestScore = s;
          best = r;
        }
      }
      if (best && bestScore >= 75) found = best;
    }

    if (found) {
      matched.push({ original, player: found.name, rating: found.rating });
    } else {
      unmatched.push({ original, player: original, rating: null });
    }
  }

  matched.sort((a, b) => b.rating - a.rating);
  let idx = 1;
  return [...matched, ...unmatched].map((row) => ({
    ...row,
    sortIndex: row.rating != null ? idx++ : "",
  }));
}

// --- UI components ---
function MarkdownTable({ rows, mode }) {
  const headings = [
    "Sort",
    "Player",
    mode === "singles" ? "Singles Rating" : "Doubles Rating",
  ];
  return (
    <div className="mt-4">
      <div className="text-sm text-gray-500 mb-2">
        Data fetched: {new Date().toISOString().split("T")[0]} • Mode:{" "}
        {mode === "singles" ? "Singles" : "Doubles"}
      </div>
      <table className="min-w-full text-sm border">
        <thead className="bg-gray-50">
          <tr>
            {headings.map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-left font-semibold"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="px-4 py-2 w-16">{r.sortIndex}</td>
              <td className="px-4 py-2">{r.player}</td>
              <td className="px-4 py-2">
                {r.rating != null ? r.rating.toFixed(3) : "No Ranking Found."}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Main App ---
export default function App() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState("doubles");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);
  const [canShowSinglesPrompt, setCanShowSinglesPrompt] = useState(false);

  const inputNames = useMemo(
    () => input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    [input]
  );

  async function run(modeToUse) {
    setError("");
    if (!inputNames.length) {
      setError("Please paste at least one name.");
      return;
    }
    setLoading(true);
    try {
      const data = await fetchRankings(modeToUse);
      setRows(applyMatching(inputNames, data));
      setMode(modeToUse);
      setCanShowSinglesPrompt(modeToUse === "doubles");
    } catch (e) {
      setError("Couldn’t parse rankings site — format may have changed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-bold">
          Pickleball Cayman Ranking Assistant
        </h1>
        <p className="text-gray-600 mt-1">
          Paste player names (line- or comma-separated). Doubles by default.
        </p>

        <textarea
          className="w-full h-40 p-3 border rounded-2xl mt-4"
          placeholder={`Example:\nJohn Doe\nFrancisco Castillo\nBig Show`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />

        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={() => run("doubles")}
            disabled={loading}
            className="px-4 py-2 rounded-2xl shadow bg-black text-white disabled:opacity-50"
          >
            {loading && mode === "doubles" ? "Working…" : "Run (Doubles)"}
          </button>

          {canShowSinglesPrompt && (
            <button
              onClick={() => run("singles")}
              disabled={loading}
              className="px-4 py-2 rounded-2xl shadow bg-gray-800 text-white disabled:opacity-50"
            >
              {loading && mode === "singles"
                ? "Working…"
                : "Show Singles as well?"}
            </button>
          )}
        </div>

        {error && (
          <div className="mt-3 p-3 rounded-2xl bg-red-50 text-red-700 border">
            {error}
          </div>
        )}
        {rows.length > 0 && <MarkdownTable rows={rows} mode={mode} />}
      </div>
    </div>
  );
  
}

