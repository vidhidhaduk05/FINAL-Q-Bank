#!/usr/bin/env node
/**
 * generate_json_from_excel.js
 * Convert Master_Question_Bank_v4_Progress.xlsx -> questions_output.json
 *
 * Usage:
 *   npm install xlsx
 *   node generate_json_from_excel.js [path/to/xlsx] [out.json]
 *
 * Defaults:
 *   input  = ./Master_Question_Bank_v4_Progress.xlsx
 *   output = ./questions_output.json
 *
 * Requires the `xlsx` (SheetJS) package:  npm install xlsx
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const INPUT = process.argv[2] || "./Master_Question_Bank_v4_Progress.xlsx";
const OUTPUT = process.argv[3] || "./questions_output.json";

// Subject sheets in display order (must match the workbook tab names)
const SUBJECTS = [
  "ENT",
  "OPHTHALMOLOGY",
  "GENERAL MEDICINE",
  "OBSTETRICS & GYNAECOLOGY",
  "PEDIATRICS",
  "GENERAL SURGERY",
  "ORTHOPAEDICS",
  "GENERAL",
];

// Friendly display names
const SUBJECT_DISPLAY = {
  "ENT": "ENT",
  "OPHTHALMOLOGY": "Ophthalmology",
  "GENERAL MEDICINE": "General Medicine",
  "OBSTETRICS & GYNAECOLOGY": "Obstetrics & Gynaecology",
  "PEDIATRICS": "Pediatrics",
  "GENERAL SURGERY": "General Surgery",
  "ORTHOPAEDICS": "Orthopaedics",
  "GENERAL": "General",
};

function countStars(val) {
  if (val == null) return 0;
  const s = String(val).trim();
  let n = 0;
  for (const ch of s) if (ch === "★" || ch === "⭐") n++;
  return n;
}

function splitList(val) {
  if (val == null) return [];
  return String(val)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function toInt(val, def = 0) {
  if (val == null || val === "") return def;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function normHeader(c) {
  return String(c == null ? "" : c)
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`ERROR: input file not found: ${INPUT}`);
    process.exit(1);
  }
  const wb = XLSX.readFile(INPUT, { cellDates: false, cellNF: false, cellText: false });
  const questions = [];
  const seenIds = new Set();
  const dupIds = [];
  const perSubject = {};

  for (const sn of SUBJECTS) {
    if (!wb.SheetNames.includes(sn)) {
      console.error(`WARNING: sheet '${sn}' not found, skipping`);
      continue;
    }
    const ws = wb.Sheets[sn];
    // rows: array of arrays; header is Excel row 4 -> index 3 (0-based)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    if (rows.length < 5) continue;

    const hdr = rows[3] || [];
    const idx = {};
    hdr.forEach((c, i) => { idx[normHeader(c)] = i; });
    const cDone = idx["Done (1=Done)"];
    const cNum = idx["#"];
    const cStars = idx["Stars"];
    const cTopic = idx["Topic"];
    const cType = idx["Type"];
    const cQ = idx["Question"];
    const cYears = idx["Years"];
    const cSources = idx["Sources"];
    const cRepeats = idx["Repeats"];
    const c2026 = idx["2026?"];

    const disp = SUBJECT_DISPLAY[sn] || sn;
    let count = 0;

    for (let r = 4; r < rows.length; r++) {
      const row = rows[r] || [];
      const num = cNum != null ? row[cNum] : null;
      const qtext = cQ != null ? row[cQ] : null;
      if (num == null && (qtext == null || String(qtext).trim() === "")) continue;

      const qid = `${sn}|${toInt(num)}`;
      if (seenIds.has(qid)) dupIds.push(qid);
      seenIds.add(qid);

      const stars = countStars(cStars != null ? row[cStars] : null);
      let is2026 = false;
      if (c2026 != null && row[c2026] != null) {
        is2026 = String(row[c2026]).trim().toUpperCase() === "YES";
      }
      let done = false;
      if (cDone != null && row[cDone] != null) {
        const dv = String(row[cDone]).trim();
        done = ["1", "TRUE", "YES"].includes(dv.toUpperCase());
      }

      questions.push({
        id: qid,
        subject: disp,
        subjectKey: sn,
        num: toInt(num),
        topic: cTopic != null && row[cTopic] != null ? String(row[cTopic]).trim() : "",
        type: cType != null && row[cType] != null ? String(row[cType]).trim() : "",
        stars,
        question: cQ != null && row[cQ] != null ? String(row[cQ]).trim() : "",
        years: splitList(cYears != null ? row[cYears] : null),
        sources: splitList(cSources != null ? row[cSources] : null),
        repeats: toInt(cRepeats != null ? row[cRepeats] : null),
        is2026,
        done,
      });
      count++;
    }
    perSubject[sn] = count;
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(questions, null, 1), "utf8");
  const stat = fs.statSync(OUTPUT);

  console.log(`Wrote ${questions.length} questions to ${OUTPUT}`);
  console.log(`File size: ${stat.size.toLocaleString()} bytes`);
  console.log("Per-subject counts:");
  for (const sn of SUBJECTS) console.log(`  ${sn}: ${perSubject[sn] || 0}`);
  if (dupIds.length) {
    console.log(`WARNING: ${dupIds.length} duplicate IDs: ${dupIds.slice(0, 10)}`);
  } else {
    console.log("ID uniqueness: OK (no duplicates)");
  }
}

main();
